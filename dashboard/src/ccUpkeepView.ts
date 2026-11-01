import type { CcSessionStatus, CcStatus } from "./api";

// The threshold must match BUSY_THRESHOLD_PCT in devd/src/ccUpkeep.ts. The dashboard does not import
// from devd (different build), so the constant is deliberately copied including this comment.
export const BUSY_THRESHOLD_PCT = 25;

export type RowState = "outdated" | "current" | "unknown";

export function isOlder(a: string, b: string): boolean {
  const x = a.split(".").map(Number); const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const p = x[i] ?? 0; const q = y[i] ?? 0;
    if (p < q) return true;
    if (p > q) return false;
  }
  return false;
}

// Lagging = old version on disk OR a pane running on an older binary. These are
// two different things: the first is fixed by installing, the second by restarting the pane.
export function rowState(s: CcSessionStatus, latest: string | null): RowState {
  if (s.version === null || s.stalePanes === null) return "unknown";   // could not be determined → we claim nothing
  if (s.stalePanes > 0) return "outdated";
  if (latest && isOlder(s.version, latest)) return "outdated";
  return "current";
}

export function busyLabel(pct: number | null): string {
  if (pct === null) return "?";
  return pct >= BUSY_THRESHOLD_PCT ? `busy ${pct} %` : `idle ${pct} %`;
}

export function paneLabel(panes: number | null, stale: number | null): string {
  if (panes === null) return "?";
  if (stale === null) return `${panes} (? stale)`;
  if (stale === 0) return String(panes);
  return `${panes} (${stale} stale)`;
}

/* ------------------------------ historie ------------------------------ */

export type HistoryTone = "ok" | "info" | "warn" | "danger";
export interface HistoryLine { tone: HistoryTone; text: string }

/** Event types that belong to the cc upkeep history. */
export const CC_EVENT_TYPES = ["cc_upgraded", "cc_skipped", "cc_restart_failed", "cc_upgrade_failed"];

function parse(data: string | null): Record<string, unknown> {
  if (!data) return {};
  try { const d = JSON.parse(data); return d && typeof d === "object" ? d as Record<string, unknown> : {}; }
  catch { return {}; }
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const panes = (n: number) => `${n} ${n === 1 ? "pane" : "panes"}`;

/** One sentence in human language instead of a raw event type. The user complained
 *  that from "cc_skipped · busy · install" they could not tell what actually happened and whether to
 *  do anything — so each variant states the REASON and whether it will fix itself. */
export function historyLine(type: string, data: string | null): HistoryLine {
  const d = parse(data);
  const to = str(d.to);
  const from = str(d.from);

  if (type === "cc_upgraded") {
    const parts: string[] = [];
    if (d.installed === true) parts.push(from ? `installed ${to} (was ${from})` : `installed ${to}`);
    const restarted = num(d.restarted);
    if (restarted > 0) parts.push(`restarted ${panes(restarted)}`);
    const stuck = num(d.stuck);
    if (stuck > 0) parts.push(`${panes(stuck)} did not come back`);
    return { tone: stuck > 0 ? "warn" : "ok", text: parts.join(", ") || `up to date on ${to ?? "the latest version"}` };
  }

  if (type === "cc_skipped") {
    if (d.reason === "busy") {
      const where = d.phase === "restart"
        ? `restart of pane ${str(d.pane) ?? "?"} postponed`
        : `install of ${to ?? "the update"} postponed`;
      return { tone: "info", text: `${where} — the agent was working. Retried on the next run.` };
    }
    if (d.reason === "did-not-exit") {
      return {
        tone: "info",
        text: `pane ${str(d.pane) ?? "?"} refused to restart — it keeps running the old version and picks up the new one on its next start.`,
      };
    }
    return { tone: "info", text: `skipped — ${str(d.reason) ?? "unknown reason"}` };
  }

  if (type === "cc_restart_failed") {
    const t = Array.isArray(d.targets) ? d.targets.map(String) : [];
    const where = t.length ? ` (${t.join(", ")})` : "";
    // A stuck pane with a running agent looks healthy in `docker ps` and in the pane count —
    // so the sentence must say the agent IS there and just waiting, otherwise you search blindly.
    if (str(d.reason) === "stuck-on-dialog") {
      return {
        tone: "danger",
        text: `${panes(t.length || 1)} stuck on the resume prompt after the restart${where} — the agent is up but waiting for an answer, it will not fix itself.`,
      };
    }
    // A pane for which we could not determine which conversation it had. Restarting it
    // blindly via `--continue` would slip it someone else's conversation (regression of 21 Aug),
    // so it stayed at the shell — and cc printed the command to get back there on exit.
    if (str(d.reason) === "unknown-session") {
      return {
        tone: "danger",
        text: `${panes(t.length || 1)} left at the shell${where} — the conversation could not be identified, so nothing was resumed. The pane prints the exact \`claude --resume …\` command to bring it back.`,
      };
    }
    return {
      tone: "danger",
      text: `${panes(t.length || 1)} left without a running agent${where} — needs a look, it will not fix itself.`,
    };
  }

  if (type === "cc_upgrade_failed") {
    const why = str(d.stderr);
    return { tone: "danger", text: `install of ${to ?? "the update"} failed${why ? ` — ${why.split("\n").at(-1)}` : ""}` };
  }

  return { tone: "info", text: type };
}

export type FleetBadge = { variant: "destructive" | "outline"; label: string };

// Summary badge above the table. Never claims "all up to date" while the state
// has not loaded yet or the state of even one session is undetermined (unknown) — that would
// hide unreachable containers as a healthy fleet. Lagging rows
// take precedence: if there are both outdated and unknown, the destructive badge is still shown.
export function fleetBadge(status: CcStatus | null): FleetBadge {
  if (status === null) return { variant: "outline", label: "?" };
  // Empty fleet is not "all up to date" — nothing to update. Table below
  // shows "No running sessions" at the same time, badge must not contradict it.
  if (status.sessions.length === 0) return { variant: "outline", label: "no sessions" };
  let outdated = 0;
  let unknown = 0;
  for (const s of status.sessions) {
    const st = rowState(s, status.latest);
    if (st === "outdated") outdated++;
    else if (st === "unknown") unknown++;
  }
  if (outdated > 0) return { variant: "destructive", label: `${outdated} of ${status.sessions.length} outdated` };
  if (unknown > 0) return { variant: "outline", label: `${unknown} of ${status.sessions.length} unknown` };
  return { variant: "outline", label: "all up to date" };
}
