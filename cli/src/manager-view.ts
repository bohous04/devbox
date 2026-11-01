import type { SessionInfo } from "./api";
import { specFor } from "../../devd/src/agents";
import type { ClaudeState } from "../../devd/src/stats";
import { tmuxLabel, type TmuxSession } from "../../devd/src/tmux";
import { agentLabel } from "./attach";
import { endEffect, sessionLabel, uptime } from "./format";

// Sentinels for menu items that are not sessions (distinct from the id `dev-<project>-…`).
export const MANAGER_NEW = "__new__";
export const MANAGER_BROWSE = "__browse__";
export const MANAGER_QUIT = "__quit__";
export const MANAGER_BACK = "__back__";
export const MANAGER_WHOLE = "__whole__";

export type DetailAction = "attach" | "rename" | "agent" | "end" | "back";

// Running sessions, most recent (last_active_at) on top.
export function runningSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions
    .filter((s) => s.status === "running")
    .sort((a, b) => b.last_active_at - a.last_active_at);
}

// Landing menu: "➕ New session" (1st), "▶ Running sessions" (2nd, with the running count)
// and "⏹ Quit". Opening Running shows the list (browseOptions).
export function landingOptions(runningCount: number): { value: string; label: string; hint?: string }[] {
  return [
    { value: MANAGER_NEW, label: "➕ New session" },
    { value: MANAGER_BROWSE, label: "▶ Running sessions", hint: `${runningCount} running` },
    { value: MANAGER_QUIT, label: "⏹ Quit" },
  ];
}

// Session activity for the hint. "active X ago" counts time since the last PROMPT
// (last_active_at) — an autonomously working session (long subagent, no input) would thus
// look idle even while it is busy. When claudeState = "working" (metrics < 30 s,
// stats.ts), show "🟢 working" instead. waiting/idle keep "active X ago" (idle 💤,
// waiting 🟡). Without claudeState (older devd) fall back to the original text.
export function activityHint(s: { claudeState?: ClaudeState; last_active_at: number }, now: number): string {
  if (s.claudeState === "working") return "🟢 working";
  const ago = `active ${uptime(now - s.last_active_at)} ago`;
  if (s.claudeState === "idle") return `💤 ${ago}`;
  if (s.claudeState === "waiting") return `🟡 ${ago}`;
  return ago;
}

// List of running sessions: one row per session (most recent on top, 🔔 for important)
// + "← Back". Back also via Backspace/Esc (mapped to clack cancel in manager.ts).
export function browseOptions(running: SessionInfo[], now: number): { value: string; label: string; hint?: string }[] {
  return [
    ...running.map((s) => ({
      value: s.id,
      label: `▶ ${sessionLabel(s)}`,
      // When it has a nickname, show project/repo in the hint too (otherwise you would lose which repo it is).
      hint: `${s.name && s.name.trim() ? `${s.project}/${s.repo} · ` : ""}${activityHint(s, now)}${s.important ? " 🔔" : ""}`,
    })),
    { value: MANAGER_BACK, label: "← Back" },
  ];
}

// Actions in the whole-session detail. `includeAttach` = only for ONE session (direct entry from the
// list → preview + Attach); for "⚙ Whole session" (container with several Claudes) Attach is
// left out — attach is per Claude (handled in that Claude's detail). "Stop/pause" is deliberately
// not here (a paused session disappears from the running ones). Per-session label renaming
// (@devd_label) is not here either — it is done in the specific Claude's detail; here there is only "Rename"
// (container nickname).
export function detailActions(includeAttach: boolean, opts: { endLabel?: string; agentNow?: string } = {}): { value: DetailAction; label: string }[] {
  const all: { value: DetailAction; label: string }[] = [
    { value: "attach", label: "Attach (take over terminal)" },
    { value: "rename", label: "Rename" },
    // Container-level action (DEVD_AGENT is shared by all windows), hence in both views.
    // The label carries the CURRENT profile — without it the user would be changing blindly.
    { value: "agent", label: `⇄ Change agent${opts.agentNow ? ` (now: ${opts.agentNow})` : ""}` },
    { value: "end", label: opts.endLabel ?? "End session (permanent)" },
    { value: "back", label: "← Back" },
  ];
  return includeAttach ? all : all.filter((o) => o.value !== "attach");
}

// Trimming raw `tmux capture-pane`: drops trailing empty lines, keeps
// the last `max`. Empty/whitespace input → [] (the caller shows "preview unavailable").
export function trimPreview(raw: string, max = 40): string[] {
  const lines = raw.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length > max ? lines.slice(-max) : lines;
}

// Exit menu after pressing F9 in a session (see reconnect.ts, code 42). "End" (closes the
// Warp tab via SIGHUP to the parent shell — handled by main.ts), "Just detach" (leaves Claude
// running, returns to the shell) and "Back to session" (attach again — F9 pressed by mistake must not
// be a one-way street). "Stop" is deliberately not here — a paused session disappears from the running ones
// (same as in the manager detail).
export type ExitAction = "back" | "end" | "detach" | "rename" | "agent" | "account";

// `worktree` = this session has its own working directory, which `end()` DELETES. The label
// must say so right here: F9 is the fastest way to end a session and at that point the user has
// nothing else in front of them to tell it from.
//
// `name` = the session's current nickname. It is in the "Rename" label on purpose: after renaming the
// menu is shown again, so the change is visible right away — otherwise the user would get no feedback
// that something happened. `null` (no nickname) is printed as `unnamed`, not empty.
//
// "Back" is the FIRST item: F9 can be pressed by mistake and with the previous order a reflexive
// Enter was straight "End session" — for a worktree session including deleting the files.
export function exitMenuOptions(worktree: boolean, name?: string | null, agentNow?: string | null, agent?: SessionInfo["agent"]): { value: ExitAction; label: string }[] {
  const account: { value: ExitAction; label: string }[] = agent === "codex"
    ? [{ value: "account", label: "⇄ Change account (Codex)" }]
    : agent !== undefined && specFor(agent).anthropicAccount
      ? [{ value: "account", label: "⇄ Change account (Claude Code — automatic selection)" }]
      : [];
  return [
    { value: "back", label: "← Back to session (reattach)" },
    { value: "end", label: `⏻ End session (permanent — ${endEffect(worktree)}) — closes tab` },
    { value: "rename", label: `✎ Rename session (now: ${name ?? "unnamed"})` },
    // The fastest path for the real flow "agent got stuck → switch to another harness":
    // the user is attached in a tab and has neither the manager nor the dashboard at hand. After the swap
    // it reattaches back (handled by handleExit in main.ts).
    { value: "agent", label: `⇄ Change agent${agentNow ? ` (now: ${agentNow})` : ""}` },
    ...account,
    { value: "detach", label: "↩︎ Just detach (Claude keeps running)" },
  ];
}

/** One sentence about the result of a live agent swap — shared by the F9 menu and the manager.
 *  `label` = label of the TARGET profile (agentLabel). */
export function agentSwitchSummary(
  r: { status: "unchanged" | "no-agent" | "switched" | "failed"; panes: { target: string; outcome: string }[] },
  label: string,
): string {
  const bad = r.panes.filter((p) => p.outcome !== "restarted");
  const detail = bad.map((p) => `${p.target} (${p.outcome})`).join(", ");
  switch (r.status) {
    case "unchanged": return `Already on ${label} — nothing to do.`;
    case "no-agent": return "No running agent found in the session — nothing switched.";
    case "failed": return `Switch failed — no pane made it onto ${label}${detail ? `: ${detail}` : ""}.`;
    case "switched": return `Switched to ${label}.${detail ? ` Warning: some panes stayed behind: ${detail}.` : ""}`;
  }
}

// List of Claudes inside a container (drill-down into a session). One row per tmux session:
// name + agent (if known, same label as the attach picker) + label/title
// (tmuxLabel) + 🔗 when someone is attached to it. Then "Whole session" (container-level
// actions) and "← Back".
//
// Creating a sub-session from here (another window over the SAME files) is no longer possible: tmux and the agent
// open a window by themselves, and "another session" today means its own container with its own
// worktree and branch — that is created when opening a repo ("Attach / New session"), not
// from inside a running container. The list stays as a menu of where to ATTACH; windows
// from earlier can still exist in the container.
export function subSessionOptions(sessions: TmuxSession[]): { value: string; label: string }[] {
  return [
    ...sessions.map((s) => {
      const meta = [s.agent ? agentLabel(s.agent) : null, tmuxLabel(s)].filter(Boolean);
      const link = s.attached > 0 ? " 🔗" : "";
      return { value: s.name, label: `${s.name}${meta.length ? ` · ${meta.join(" · ")}` : ""}${link}` };
    }),
    { value: MANAGER_WHOLE, label: "⚙ Whole session (rename · end all)" },
    { value: MANAGER_BACK, label: "← Back" },
  ];
}

export type SubAction = "attach" | "rename" | "kill" | "back";

// Actions in the detail of one Claude (order = menu order).
export function subDetailActions(): { value: SubAction; label: string }[] {
  return [
    { value: "attach", label: "Attach (take over terminal)" },
    { value: "rename", label: "Rename" },
    { value: "kill", label: "End this Claude (permanent)" },
    { value: "back", label: "← Back" },
  ];
}
