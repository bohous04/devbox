import { AGENTS, AGENT_IDS, isAgentName, RUNTIME_BIN, type AgentName } from "../../devd/src/agents";
import type { SessionRow } from "../../devd/src/db";
import type { TreeProject } from "../../devd/src/tree";
import type { ClaudeState } from "../../devd/src/stats";
import { activityHint } from "./manager-view";
import type { Target } from "./resolve";

export interface PickerData { tree: TreeProject[]; recents: Target[] }

// Sentinel value for the "start a fresh claudeSolo" choice in the solo menu, kept
// distinct from any session id (which are `dev-<project>-claudeSolo-<n>`).
export const NEW_SOLO = "__new__";

export function folderOptions(tree: TreeProject[]) {
  return [...new Set(tree.map((p) => p.folder))].sort().map((f) => ({ value: f, label: f }));
}

export function projectOptions(tree: TreeProject[], folder: string) {
  return tree.filter((p) => p.folder === folder).map((p) => p.project).sort()
    .map((p) => ({ value: p, label: p }));
}

export function repoOptions(tree: TreeProject[], recents: Target[], folder: string, project: string) {
  const proj = tree.find((p) => p.folder === folder && p.project === project);
  const names = (proj?.repos ?? []).map((r) => r.name);
  const recentNames = recents.filter((r) => r.folder === folder && r.project === project).map((r) => r.repo);
  const ordered = [
    ...recentNames.filter((n) => names.includes(n)),
    ...names.filter((n) => !recentNames.includes(n)).sort(),
  ];
  const opts = ordered.map((n) => {
    const cloned = proj?.repos.find((r) => r.name === n)?.cloned;
    return cloned ? { value: n, label: n, hint: "cloned" } : { value: n, label: n };
  });
  return [...opts, { value: "claudeSolo", label: "🤖 claudeSolo (one-off workspace)" }];
}

// Running claudeSolo sessions of one project, most recently active first — the
// list shown under the "new session" button when you pick claudeSolo. Generic over
// T so that SessionInfo (with claudeState from /api/sessions) reaches the menu without losing state.
export function runningSolosIn<T extends SessionRow>(sessions: T[], folder: string, project: string): T[] {
  return sessions
    .filter((s) => s.solo === 1 && s.status === "running" && s.folder === folder && s.project === project)
    .sort((a, b) => b.last_active_at - a.last_active_at);
}

// Menu for picking claudeSolo when sessions are already running: "new" first, then
// each running one. Hint via activityHint — a working solo shows "🟢 working", not
// "active X ago" (same fix as the session manager). Without claudeState, fall back to "X ago".
export function soloMenuOptions(running: (SessionRow & { claudeState?: ClaudeState })[], now: number): { value: string; label: string; hint?: string }[] {
  return [
    { value: NEW_SOLO, label: "➕ New claude solo session" },
    ...running.map((s) => ({
      value: s.id,
      label: `▶ ${s.repo}`,
      hint: `${activityHint(s, now)}${s.important ? " 🔔" : ""}`,
    })),
  ];
}

export function soloEndOptions() {
  return [
    { value: "delete" as const, label: "Delete" },
    { value: "keep" as const, label: "Keep" },
    { value: "gist" as const, label: "Save as gist and delete" },
  ];
}

// The full action menu for an existing claudeSolo session: attach is only meaningful
// while the container is running, and gist creation execs into that same container —
// so a stopped session collapses to just the keep/delete decision (no attach, no gist).
export function soloActionOptions(status: "running" | "stopped") {
  const attach = status === "running" ? [{ value: "attach" as const, label: "Attach" }] : [];
  const end = soloEndOptions().filter((o) => status === "running" || o.value !== "gist");
  return [...attach, ...end];
}

// "Save as gist and delete" must never destroy work the gist didn't capture:
// delete the workspace only when `gh gist create` actually succeeded.
export function gistOutcome(code: number): "delete" | "keep" {
  return code === 0 ? "delete" : "keep";
}

// `dev --agent <id> <target>` — forcing a profile outside the interactive picker.
// `--claude` / `--codex` remain as shortcuts (people still have them in their fingers
// and in shell history). When several are given, the explicit `--agent` wins.
export function agentFlag(argv: string[]): AgentName | undefined {
  const i = argv.indexOf("--agent");
  if (i >= 0 && isAgentName(argv[i + 1])) return argv[i + 1] as AgentName;
  if (argv.includes("--codex")) return "codex";
  if (argv.includes("--claude")) return "claude";
  return undefined;
}

/** Removes the profile choice from argv. `--agent` takes its VALUE along — otherwise
 *  `dev --agent grok` would end up searching for a repo named "grok". */
export function stripAgentFlags(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--agent") { i++; continue; }
    if (raw[i] === "--codex" || raw[i] === "--claude") continue;
    out.push(raw[i]);
  }
  return out;
}

/** `--instabox` / `--on=instabox` = open on InstaBox (always a new session). `--on=vps` is the default. */
// `--on` also takes the value as the next argument (`--on instabox`, `--on vps`) — only when it
// really is a host; anything else after `--on` is not swallowed (M9).
const HOSTS = new Set(["instabox", "vps"]);
function hostArgs(argv: string[]): { host: string | undefined; rest: string[] } {
  let host: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--instabox") host = "instabox";
    else if (a.startsWith("--on=") && HOSTS.has(a.slice(5))) host = a.slice(5);
    else if (a === "--on" && HOSTS.has(argv[i + 1] ?? "")) host = argv[++i];
    else rest.push(a);
  }
  return { host, rest };
}
export function hostFlag(argv: string[]): "instabox" | undefined {
  return hostArgs(argv).host === "instabox" ? "instabox" : undefined;
}
export function stripHostFlags(raw: string[]): string[] {
  return hostArgs(raw).rest;
}

// Asking for the agent makes sense only in the step picker (`dev` without a target) on a TTY and only when
// a flag did not force the choice. `dev <query>`, notification clicks and automation take
// the remembered choice silently (spec, decision 3).
export function shouldAskAgent(query: string | undefined, forced: AgentName | undefined, isTty: boolean): boolean {
  return query === undefined && forced === undefined && isTty;
}

// Agent choice in the picker. The label is built from AGENTS (the single source of truth — no
// hardcoded list of profiles), the remembered choice is first and marked with a hint.
// `hint` is overridden by the agent swap on a running session ("current") — there "last used
// here" lies: the first one is the session's CURRENT profile, not the repo's memory.
export function agentOptions(remembered: AgentName, hint = "last used here"): { value: AgentName; label: string; hint?: string }[] {
  const all = AGENT_IDS.map((value) => {
    const s = AGENTS[value];
    return { value, label: `${s.label} (${RUNTIME_BIN[s.runtime]}${s.yolo ? " · yolo" : ""})` };
  });
  const first = all.find((o) => o.value === remembered) ?? all[0];
  const rest = all.filter((o) => o.value !== first.value);
  return [{ ...first, hint }, ...rest];
}

/** Label of the "create another session" choice — derived from the ACTUAL repo layout, not from
 *  wishes. A session gets its own worktree and branch only where the repo is in the new layout
 *  (`bare`), or is yet to be cloned (`!cloned` → cloned straight as bare). For a repo
 *  in the OLD layout, "another session" is its own container, ports and notifications, but over
 *  the SAME files and the same branch — two agents over one git index. Promising
 *  isolation there would be exactly the silent misunderstanding this plan otherwise closes.
 *  The condition mirrors `open()` (`isBareLayout(...) || !existsSync(ws)`). */
export function freshLabel(t: { bare?: boolean; cloned: boolean }): string {
  return t.bare || !t.cloned
    ? "New session (own worktree and branch)"
    : "New session (shares this repo's working directory and branch)";
}
