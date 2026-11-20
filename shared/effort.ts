import type { ThreadEffort } from "./thread";

/** Every reasoning effort level devd and the apps accept: Claude Code's EffortLevel (low … max) and the levels the
 *  Codex app-server's model/list names (also none, minimal, ultra). A level outside this list never reaches the
 *  bridge, the thread store or the UI: a new one is added here first. */
export const KNOWN_EFFORT_LEVELS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export const isKnownEffort = (v: unknown): v is string => typeof v === "string" && KNOWN_EFFORT_LEVELS.includes(v);

/** An effort.state's facts with every level outside KNOWN_EFFORT_LEVELS dropped (a listed one left out, an unknown
 *  effective or chosen level as not known); `dropped` names what went, for the caller to log. */
export function knownEffort(e: ThreadEffort): { effort: ThreadEffort; dropped: string[] } {
  const dropped: string[] = [];
  const keep = (l: string | null) => {
    if (l === null || isKnownEffort(l)) return l;
    dropped.push(l);
    return null;
  };
  const supported = e.supported === null ? null : e.supported.filter((l) => keep(l) !== null);
  return { effort: { model: e.model, supported, effective: keep(e.effective), chosen: keep(e.chosen) }, dropped };
}
