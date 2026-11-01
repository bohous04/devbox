// Reading tmux sessions inside a devbox container (`main`, `main-2`, …) — pure functions
// shared by the CLI (attach picker, manager) and devd (/api/sessions?tmux=1). No I/O.

import { isAgentName, type AgentName } from "./db";
import { dockerArgv } from "./dockerTarget";

export interface TmuxSession {
  name: string;          // tmux session name = identifier for attach/capture-pane
  label: string | null;  // manual label (@devd_label), null = not set
  agent: AgentName | null; // from the tmux option @devd_agent (set by agent-launch)
  title: string | null;  // raw #{pane_title} of the active pane (Claude sets it itself)
  attached: number;      // number of clients attached to EXACTLY this session
}

const SEP = "\t";

// One call instead of two execs (formerly list-sessions + list-clients). `list-sessions -F`
// also handles pane-scope variables — it expands them against the session's active pane (verified on
// tmux 3.4 in the image). The separator is a tab: Claude titles routinely contain `|`.
export function probeCmd(): string {
  return `tmux list-sessions -F '#{session_name}${SEP}#{@devd_label}${SEP}#{@devd_agent}${SEP}#{pane_title}${SEP}#{session_attached}' 2>/dev/null`;
}

// Probe output → list of sessions; `main` first, then alphabetically. Corrupted lines are
// skipped (the probe must never bring down the caller). The format is five fields; the old
// four-column output is DELIBERATELY not tolerated — `probeCmd` and `parseProbe` are deployed
// together and "4 or 5 fields" could not be told apart from a line with a tab in the title. An unknown
// user option is expanded by tmux to empty, so even a container from an older image returns five
// fields. The title may contain a tab, which is why everything between the third and the
// LAST field is taken.
export function parseProbe(raw: string): TmuxSession[] {
  const rows: TmuxSession[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    if (parts.length < 5) continue;
    const name = parts[0].trim();
    if (!name) continue;
    const label = parts[1].trim();
    const agent = parts[2].trim();
    const title = parts.slice(3, -1).join(SEP).trim();
    rows.push({
      name,
      label: label || null,
      agent: isAgentName(agent) ? agent : null,
      title: title || null,
      attached: Number.parseInt(parts[parts.length - 1], 10) || 0,
    });
  }
  return rows.sort((a, b) => (a.name === "main" ? -1 : b.name === "main" ? 1 : a.name.localeCompare(b.name)));
}

// Leading Claude Code status glyphs: braille spinner (U+2800–U+28FF) and star
// dingbats (✳ ✻ ✽ ✶, U+2700–U+27BF), plus bullets and spaces.
const LEADING_GLYPHS = /^[⠀-⣿✀-➿·•*\s]+/;
// Titles that say nothing: shells and Claude's idle title ("✳ Claude Code").
const NOISE = new Set(["claude code", "claude", "zsh", "bash", "sh", "node", "tmux"]);
// tmux default pane title = container hostname = 12 hex characters (docker container id).
const HOSTNAME_LIKE = /^[0-9a-f]{12}$/;
export const MAX_LABEL = 45;

export function cleanTitle(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.replace(LEADING_GLYPHS, "").trim();
  if (!t) return null;
  if (NOISE.has(t.toLowerCase())) return null;
  if (HOSTNAME_LIKE.test(t)) return null;
  return t;
}

// Displayed session label: manual @devd_label → cleaned-up Claude title → nothing
// (the caller then shows a bare `main-N`).
export function tmuxLabel(s: TmuxSession, max = MAX_LABEL): string | null {
  const raw = s.label ?? cleanTitle(s.title);
  if (!raw) return null;
  return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw;
}

export type TmuxExec = (container: string, cmd: string, timeoutMs: number) => Promise<string>;

// `docker exec` without blocking the event loop (devd is single-threaded and /api/sessions is
// polled). Non-zero exit or exception → "" → the caller gets an empty list.
const defaultExec: TmuxExec = async (container, cmd, timeoutMs) => {
  try {
    const p = Bun.spawn([...dockerArgv(container), "exec", container, "bash", "-lc", cmd], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already finished */ } }, timeoutMs);
    const code = await p.exited;
    clearTimeout(timer);
    if (code !== 0) return "";
    return await new Response(p.stdout).text();
  } catch { return ""; }
};

// Probe across several containers at once: in parallel, with a short cache (repeated `dev ls` and
// manager redraws would otherwise spam docker) and a per-container timeout (an unresponsive
// container must not delay the whole response).
export function createTmuxProbe(opts: { ttlMs?: number; timeoutMs?: number; exec?: TmuxExec } = {}) {
  const ttl = opts.ttlMs ?? 3_000;
  const timeout = opts.timeoutMs ?? 1_500;
  const exec = opts.exec ?? defaultExec;
  const cache = new Map<string, { at: number; rows: TmuxSession[] }>();
  return async (containers: string[], now = Date.now()): Promise<Record<string, TmuxSession[]>> => {
    const out: Record<string, TmuxSession[]> = {};
    const stale: string[] = [];
    for (const c of containers) {
      const hit = cache.get(c);
      if (hit && now - hit.at < ttl) out[c] = hit.rows;
      else stale.push(c);
    }
    await Promise.all(stale.map(async (c) => {
      let rows: TmuxSession[] = [];
      try { rows = parseProbe(await exec(c, probeCmd(), timeout)); } catch { rows = []; }
      cache.set(c, { at: now, rows });
      out[c] = rows;
    }));
    return out;
  };
}

// Safe tmux session name: the only names we ever create (`main`, `main-<n>`).
// Prevents injection into `docker exec … bash -lc "<cmd>"` as well as creating junk via new-session -A.
export function isValidTmuxName(name: string): boolean {
  return /^main(-\d+)?$/.test(name);
}

// Wrapping arbitrary text in single quotes for `bash -lc`.
export function singleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Writing the session's manual label (@devd_label). Empty/null → `set -u` (clear the label →
// the session falls back to the live Claude title). Validate the session name with `isValidTmuxName`.
export function labelSetCmd(session: string, name: string | null): string {
  if (!name) return `tmux set -u -t ${session} @devd_label 2>/dev/null`;
  return `tmux set -t ${session} @devd_label ${singleQuote(name)} 2>/dev/null`;
}

// Killing ONE tmux session (one Claude) without affecting the container. 2>/dev/null:
// a nonexistent session does not bring down the caller. Validate the name with `isValidTmuxName`.
export function killSessionCmd(session: string): string {
  return `tmux kill-session -t ${session} 2>/dev/null`;
}
