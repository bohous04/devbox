import type { AgentName, TreeProject } from "./api";

// The "New session" cascade (mirrors cli/src/picker.ts, without recents — the dashboard has none).
export const SOLO = "claudeSolo";

// Mirrors devd/src/agents.ts (the dashboard is deliberately separated from devd sources, see
// SessionLive in api.ts) — only the fields the dashboard needs: label for the select,
// short for the badge/heading, yolo for the option caption, proxy for InstaBox (usesProxy
// in devd/src/agents.ts — proxy profiles go through CLIProxyAPI/OpenRouter and are not
// reachable from VM v1, the server rejects them on InstaBox with 400). The order is the UI order,
// same as AGENT_IDS in devd (default first, then proxy variants, then standalone CLIs).
// Parity with devd is guarded by a test in newSession.test.ts that compares both tables directly —
// a silent drift could not be detected otherwise, because production code must not import
// devd here (the dashboard is a vite bundle for the browser, devd is a server).
export interface AgentProfile { label: string; short: string; yolo: boolean; proxy: boolean }

export const AGENT_PROFILES: Record<AgentName, AgentProfile> = {
  claude:        { label: "Claude Code",        short: "Claude",      yolo: true, proxy: false },
  "claude-gpt":  { label: "Claude Code + GPT",  short: "Claude+GPT",  yolo: true, proxy: true },
  "claude-grok": { label: "Claude Code + Grok", short: "Claude+Grok", yolo: true, proxy: true },
  "claude-gemini": { label: "Claude Code + Gemini", short: "Claude+Gemini", yolo: true, proxy: true },
  "claude-openrouter": { label: "Claude Code + OpenRouter", short: "Claude+OR", yolo: true, proxy: true },
  codex:         { label: "Codex",              short: "Codex",       yolo: true, proxy: false },
  grok:          { label: "Grok Build",         short: "Grok",        yolo: true, proxy: false },
  antigravity:   { label: "Antigravity",        short: "Antigravity", yolo: true, proxy: false },
};

export const AGENT_IDS = Object.keys(AGENT_PROFILES) as AgentName[];

// Mirrors usesProxy from devd/src/agents.ts — proxy agents run only on the VPS (on InstaBox
// the server rejects them with 400). This way the dashboard knows, without a hardcoded second
// copy of the list, which profile the InstaBox button must avoid.
export function isProxyAgent(agent: AgentName): boolean {
  return AGENT_PROFILES[agent].proxy;
}

// Mirrors instaboxAgentBlock from devd/src/agents.ts: proxy profiles and Antigravity run only
// on the VPS (the server rejects them on InstaBox with 400 on create and on a live agent switch).
export function instaboxAgentBlock(agent: AgentName): string | null {
  if (isProxyAgent(agent)) return "Proxy agents run only on the VPS";
  if (agent === "antigravity") return "Antigravity runs only on the VPS";
  return null;
}

/** Normalizes text to a profile — mirrors `agentNameFor` from devd/src/agents.ts
 *  (it cannot be imported here — this is a vite bundle for the browser). `agent` comes
 *  from the API as a plain string; the fallback to claude is the same as in devd and
 *  agent-launch.sh — an unknown profile must not bring down the UI. */
export function agentNameFor(agent: string | null | undefined): AgentName {
  return agent !== null && agent !== undefined && Object.hasOwn(AGENT_PROFILES, agent)
    ? (agent as AgentName)
    : "claude";
}

/** Profile for a value that is really just text. `AGENT_PROFILES[s.agent]`
 *  is a trap: an unknown value returns `undefined` and reading `.short` on it crashes the render
 *  of the whole sessions page — so always go through agentNameFor. */
export function profileFor(agent: string | null | undefined): AgentProfile {
  return AGENT_PROFILES[agentNameFor(agent)];
}

// Default agent for a repo = the remembered choice from the tree (repo_prefs), otherwise claude.
// claudeSolo is not a real repo; its memory hangs on the project as soloAgent.
export function defaultAgentFor(tree: TreeProject[], folder: string, project: string, repo: string): AgentName {
  const proj = tree.find((p) => p.folder === folder && p.project === project);
  if (!proj) return "claude";
  if (repo === SOLO) return proj.soloAgent ?? "claude";
  return proj.repos.find((r) => r.name === repo)?.agent ?? "claude";
}

export function folderChoices(tree: TreeProject[]): string[] {
  return [...new Set(tree.map((p) => p.folder))].sort();
}

export function projectChoices(tree: TreeProject[], folder: string): string[] {
  return tree.filter((p) => p.folder === folder).map((p) => p.project).sort();
}

// Flat folders (repos directly under the folder) are folded in the tree into one project
// named like the folder (project === folder). Such a folder — and in general any folder
// with a single project — makes the middle "Project" step pure friction (on mobile
// it looks like "the folder has no subfolders → nothing to pick"). We auto-select it.
export function soleProject(tree: TreeProject[], folder: string): string | null {
  const ps = projectChoices(tree, folder);
  return ps.length === 1 ? ps[0] : null;
}

// `bare` = the repo is in the new layout, so every session on it gets its own worktree
// and branch. In the old layout a second session shares files and branch with the first — "New
// session" must say so, not do it silently.
export interface RepoChoice { value: string; label: string; cloned: boolean; bare?: boolean; cloneUrl?: string }

export function repoChoices(tree: TreeProject[], folder: string, project: string): RepoChoice[] {
  const proj = tree.find((p) => p.folder === folder && p.project === project);
  const repos = (proj?.repos ?? [])
    .map((r) => ({ value: r.name, label: r.cloned ? `${r.name} (cloned)` : r.name, cloned: r.cloned, bare: r.bare, cloneUrl: r.cloneUrl }))
    .sort((a, b) => a.value.localeCompare(b.value));
  return [...repos, { value: SOLO, label: SOLO, cloned: false }];
}

/** Sessions that exist on this repo. Sorted by id, so the first in the list
 *  is the one without the ordinal suffix.
 *
 *  Status is deliberately NOT filtered: a stopped session still occupies its id, ports
 *  and worktree, and "Open" starts it back up, so for the question "should I offer a new one?"
 *  it counts the same as a running one. Hence `sessionsFor`, not `runningSessionsFor` —
 *  the name would lie. */
export function sessionsFor<T extends { project: string; repo: string; id: string }>(
  sessions: T[], project: string, repo: string,
): T[] {
  return sessions.filter((s) => s.project === project && s.repo === repo)
    .sort((a, b) => a.id.localeCompare(b.id));
}
