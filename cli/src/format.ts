import type { OpenProgress, SessionInfo } from "./api";
import { tmuxLabel, type TmuxSession } from "../../devd/src/tmux";
import { agentLabel } from "./attach";

// Clears the screen and scrollback and moves the cursor to the last line so the following
// menu (clack) renders at the BOTTOM of a clean screen (not at the top) and does not pile up during
// navigation — especially on "← Back". Shared by the session manager and the "New session" flow.
export function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  const rows = process.stdout.rows ?? 40;
  process.stdout.write(`\x1b[2J\x1b[3J\x1b[${rows};1H`);
}

/** What `end()` actually does with the files — ONE source of the sentence for all places that
 *  report ending (confirmation, post-end messages, F9 menu). Shared on purpose: previously
 *  these five places each kept their own "workspace stays" text and after worktree sessions
 *  were introduced all of them at once started claiming the opposite of what happens.
 *
 *  Worktree session: `end()` calls `git worktree remove --force`, which deletes the WHOLE directory
 *  — tracked changes, untracked files and things like `.env.local`. Nothing remains, neither
 *  in the reflog nor in a stash; only commits on the branch survive (the branch stays on purpose).
 *  The old layout (shared repo workspace, `worktree === null`) is not deleted — it also belongs
 *  to the other sessions on the same repo. */
export function endEffect(worktree: boolean): string {
  return worktree
    ? "this session's files are deleted, its branch stays"
    : "the workspace stays";
}

/** Confirmation when ending a session. It names the SESSION (id), not the repo: with several sessions on
 *  one repo, "End shop/cms?" would not tell the user which one disappears — and a
 *  worktree is deleted behind it, so this is the most destructive question in the whole tool.
 *
 *  `whole` = came from "⚙ Whole session", i.e. from a container with several agent windows.
 *  Those WINDOWS are ended (one container, `api.end(s.id)`), NOT all sessions of the repo —
 *  while the repo had one session it was the same thing; with a second one it is not, and the text promised more
 *  than happens. */
export function endPrompt(id: string, opts: { whole: boolean; worktree: boolean }): string {
  return `End session ${id}?${opts.whole ? " Closes all agent windows in it." : ""}`
    + ` Permanent — ${endEffect(opts.worktree)}.`;
}

export function uptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

// Display label of a session: nickname (name), otherwise project/repo. An empty/whitespace
// nickname falls back to project/repo (the server stores it as null, but be robust).
export function sessionLabel(s: { name?: string | null; project: string; repo: string }): string {
  return s.name && s.name.trim() ? s.name.trim() : `${s.project}/${s.repo}`;
}

// Sub-rows with tmux sessions under a container. Printed only when there is more than
// one session or at least one has a meaningful label — a lone `main` without a label adds nothing.
// The agent (if known for that tmux session) is appended after the name just like in the attach
// picker (sessionPickerOptions), so that `dev ls` on a container with main=Codex + main-2=Claude
// shows which is which.
function tmuxLines(rows: TmuxSession[] | undefined): string[] {
  if (!rows?.length) return [];
  const labels = rows.map((r) => tmuxLabel(r));
  if (rows.length < 2 && !labels.some(Boolean)) return [];
  const w = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r, i) => {
    const meta = [r.agent ? agentLabel(r.agent) : null, labels[i]].filter(Boolean);
    return `    └ ${r.name.padEnd(w)}${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
  });
}

export function formatSessions(rows: SessionInfo[], now = Date.now()): string {
  if (rows.length === 0) return "No sessions.";
  return rows.map((r) => {
    const dot = r.status === "running" ? "●" : "○";
    const state = r.status === "running" ? `running ${uptime(now - r.created_at)}` : "stopped";
    const ports = `ports ${r.ports[0]?.host}–${r.ports.at(-1)?.host}`;
    const solo = r.solo ? " · claudeSolo" : "";
    const nick = r.name && r.name.trim() ? ` "${r.name.trim()}"` : "";
    return [`${dot} ${r.project}/${r.repo}${nick}  ${state} · ${ports}${solo}`, ...tmuxLines(r.tmux)].join("\n");
  }).join("\n");
}

export function formatPorts(row: SessionInfo, host: string): string {
  return row.ports.map((p) => `${p.container} → http://${host}:${p.host}`).join("\n");
}

export function formatDoctor(checks: { name: string; ok: boolean; hint?: string }[]): string {
  return checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.name}${!c.ok && c.hint ? `\n   ↳ ${c.hint}` : ""}`).join("\n");
}

// Line for the `dev` spinner during open(): "cloning · Receiving objects 45% · 3.21 GiB | 30.12 MiB/s".
const OPEN_STEP: Record<string, string> = {
  clone: "cloning", fetch: "fetching", worktree: "checking out", pull: "pulling", container: "starting container",
};

/** One spinner line for a running open. A step this CLI does not know yet (newer devd) is shown by
 *  its raw name rather than as "undefined". `elapsedMs` is the CLI's own clock since the open began. */
export function formatOpenProgress(p: OpenProgress, elapsedMs?: number): string {
  const git = p.step === "clone" ? p.clone : p.git;
  const parts: (string | undefined)[] = [OPEN_STEP[p.step] ?? p.step];
  // Clone phases differ (receiving, resolving deltas); a checkout only ever says "Updating files".
  if (git) parts.push(p.step === "clone" ? `${git.phase} ${git.percent}%` : `${git.percent}%`, git.detail);
  if (p.detail) parts.push(p.detail);
  if (elapsedMs !== undefined) parts.push(`${Math.round(elapsedMs / 1000)} s`);
  return parts.filter(Boolean).join(" · ");
}
