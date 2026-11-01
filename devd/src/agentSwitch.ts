// Swapping the agent (harness) on a RUNNING session — the action behind `POST /api/sessions/:id/agent`.
// Unlike switching the profile on open (sessions.ts open(), container recreate),
// the container is NOT TORN DOWN here: a recreate would delete the per-session conversation overlay
// (/home/dev/.claude/projects/-workspace, see resume-session-isolation) and with it the
// possibility of `--resume`. Instead, in every pane with a live agent the agent is stopped
// and `agent-launch <new profile>` is started in THE SAME pane — the whole restart protocol
// (graceful `/exit`, id harvesting, resume dialog) is the shared restartPane in ccUpkeep.ts.
//
// Environment: the old agent-launch left profile variables exported in the pane's shell
// (ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, …) and the container-level env carries the DEVD_* values
// of the OLD profile — both would silently send the new profile to the wrong upstream. The prefix
// of the launch command therefore unsets all profile variables and exports the DEVD_* values
// of the new profile (the same "export into the pane's shell" pattern as accountSwitch,
// and for the same reason: a one-off prefix would leave the next manual launch on the old
// values). The tmux global env is overwritten too — for windows created LATER (web
// terminal, attach guard). The baked-in container env cannot be changed at runtime; a mismatch
// with the DB is handled by the recreate check in sessions.ts open() on the next open of a stopped session.
//
// The DB (sessions.agent + repo_prefs) is written ONLY after a verified restart of at least
// one pane — the same rule as accountSwitch: a restart in the middle of a live
// conversation must not make the DB claim something that did not happen.

import type { Database } from "bun:sqlite";
import {
  AGENT_RUNTIMES, AGENTS, agentNameFor, conversationCarries, SLASH_EXIT_RUNTIMES,
  type AgentName, type AgentRuntime,
} from "./agents";
import {
  agentProcsUnder, parsePanes, parseProcTree, restartPane,
  PANES_CMD, PS_TREE_CMD, type Pane, type Proc, type RestartDeps, type RestartOutcome,
} from "./ccUpkeep";
import { getSession, logEvent, setRepoAgent, setSessionAgent } from "./db";
import { PROXY_ENV_KEYS } from "./sessions";
import { singleQuote } from "./tmux";

/** Variables agent-launch exports per profile — after the agent is stopped they remain
 *  in the pane's shell and must be cleaned up before another profile is launched. A mirror of the exports
 *  in image/agent-launch.sh (guarded by the test "every export from --print-env is in PROFILE_ENV"
 *  in agentLaunch.test.ts); the DEVD_* inputs have their own list PROXY_ENV_KEYS next to
 *  their emitter proxyEnv() in sessions.ts. */
export const PROFILE_ENV = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY", "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "ENABLE_TOOL_SEARCH", "DEVBOX_PROXY_PROFILE",
] as const;

// Image default (Dockerfile ENV). Reset, NOT unset: without the variable cc would go to
// ~/.claude.json instead of the shared claude-home (see the comment in agent-launch.sh).
// Native claude overrides it right away via account-lease anyway.
const DEFAULT_CONFIG_DIR = "/home/dev/.claude";

/** Launch command prefix: cleans up the old profile's variables and exports
 *  the new one's DEVD_* values — into the pane's SHELL (export, not a one-off prefix). */
export function switchShellPrefix(target: AgentName, proxy: Record<string, string>): string {
  const unsets = [...PROFILE_ENV, ...PROXY_ENV_KEYS.filter((n) => !(n in proxy))];
  const exports: Record<string, string> = { DEVD_AGENT: target, CLAUDE_CONFIG_DIR: DEFAULT_CONFIG_DIR, ...proxy };
  const pairs = Object.entries(exports).map(([k, v]) => `${k}=${singleQuote(v)}`).join(" ");
  return `unset ${unsets.join(" ")}; export ${pairs}; `;
}

/** Launch command of the new profile. agent-launch passes `--resume` on to the binary
 *  (an older image without forwarding silently drops the argument → clean start, nothing crashes). */
export function agentLaunchCmd(target: AgentName, resumeId: string | null): string {
  return `/usr/local/bin/agent-launch ${target}${resumeId ? ` --resume ${resumeId}` : ""}`;
}

/** Switching the tmux global env — windows created AFTER the swap (web terminal `main-N`,
 *  attach guard after `main` crashes) must get the new profile, otherwise `agent-launch`
 *  without an argument would take the old profile's baked-in container-level DEVD_AGENT. */
export function tmuxEnvScript(target: AgentName, proxy: Record<string, string>): string {
  const set = Object.entries({ DEVD_AGENT: target as string, ...proxy })
    .map(([k, v]) => `tmux set-environment -g ${k} ${singleQuote(v)}`);
  const unset = PROXY_ENV_KEYS.filter((n) => !(n in proxy)).map((n) => `tmux set-environment -gu ${n}`);
  return [...set, ...unset].join("; ");
}

/** "unknown-session" cannot happen here (requireId: false — an unverifiable id means
 *  a clean start, not a blocked pane), the rest of the union is shared with restartPane. */
export type PaneSwitchOutcome = Exclude<RestartOutcome, "unknown-session">;
export interface PaneAgentResult { target: string; outcome: PaneSwitchOutcome }

export type SwitchAgentStatus =
  | "unknown-session"
  | "not-running"
  // Target == the profile in the DB — nothing to do. (A forced restart of the same profile is a different
  // operation and is done by ccUpkeep / accountSwitch.)
  | "unchanged"
  // Another swap (of agent OR account — the lock is shared) on the same session is running right now.
  | "in-progress"
  // No agent is running in any pane — nobody to swap. The DB does not change.
  | "no-agent"
  | "switched"
  // At least one pane attempted the swap, but none succeeded verifiably —
  // the DB stays on the old profile (see the comment at the top).
  | "failed";

export type SwitchAgentResult =
  | { status: Exclude<SwitchAgentStatus, "switched" | "failed"> }
  | { status: "switched" | "failed"; panes: PaneAgentResult[] };

export interface SwitchAgentDeps extends RestartDeps {
  db: Database;
  now: () => number;
  /** Shared with accountSwitch (index.ts) — both operations restart the same panes
   *  and a race on one session would throw away each other's in-progress turns. */
  inFlight: Set<string>;
  /** Fresh DEVD_* env for the target profile (key from the vault/file, model from the config,
   *  context window) — the same assembly a new container gets (sessions.ts). */
  proxyEnvFor: (agent: AgentName) => Promise<Record<string, string>>;
}

// Agent swap in ONE pane — a plan for the shared restartPane. Claude leaves
// gracefully (`/exit`), other runtimes by kill; the conversation id is harvested and passed on
// (`--resume`) only when the target profile can take it over (conversationCarries — THE SAME
// predicate by which the CLI promises "the conversation will/will not be kept").
// requireId: false — an unverifiable id does NOT BLOCK the swap (unlike the nightly
// upkeep): the user explicitly asked for it and a clean start is safe.
async function switchPane(
  deps: SwitchAgentDeps, container: string, pane: Pane, proc: Proc,
  target: AgentName, prefix: string,
): Promise<PaneSwitchOutcome> {
  const fromRuntime = proc.comm as AgentRuntime;   // comm passed the AGENT_RUNTIMES filter
  const outcome = await restartPane(deps, container, pane, {
    cmdPrefix: prefix,
    launch: (id) => agentLaunchCmd(target, id),
    exit: SLASH_EXIT_RUNTIMES.has(fromRuntime) ? "slash-exit" : { kill: proc.pid, comm: proc.comm },
    harvestId: conversationCarries(fromRuntime, AGENTS[target].runtime),
    requireId: false,
    returnComm: AGENTS[target].runtime,
    agentPid: proc.pid,
  });
  return outcome === "unknown-session" ? "did-not-return" : outcome;   // requireId:false → cannot happen
}

export async function switchAgent(deps: SwitchAgentDeps, sessionId: string, target: AgentName): Promise<SwitchAgentResult> {
  const s = getSession(deps.db, sessionId);
  if (!s) return { status: "unknown-session" };
  if (s.status !== "running") return { status: "not-running" };
  // agent-launch runs an unknown value in the DB as claude — the same holds for "is it the same choice?"
  // (agentNameFor = the same fallback as specFor / agent-launch.sh).
  const from = agentNameFor(s.agent);
  if (from === target) return { status: "unchanged" };
  if (deps.inFlight.has(sessionId)) return { status: "in-progress" };

  deps.inFlight.add(sessionId);
  try {
    const [list, ps] = await Promise.all([
      deps.exec(s.container, PANES_CMD, 15_000),
      deps.exec(s.container, PS_TREE_CMD, 15_000),
    ]);
    if (list.code !== 0 || list.timedOut || ps.code !== 0 || ps.timedOut) {
      return { status: "failed", panes: [] };   // unreachable container
    }
    const procs = parseProcTree(ps.stdout);
    const targets = parsePanes(list.stdout)
      .map((pane) => ({ pane, proc: agentProcsUnder(pane.pid, procs, AGENT_RUNTIMES)[0] }))
      .filter((t): t is { pane: Pane; proc: Proc } => t.proc !== undefined);
    if (targets.length === 0) return { status: "no-agent" };

    const proxy = await deps.proxyEnvFor(target);
    // Tmux env first: even if restarting the panes fails, windows created LATER should already
    // run on the new profile — exactly what the user has just chosen.
    await deps.exec(s.container, ["sh", "-c", tmuxEnvScript(target, proxy)], 10_000);

    const prefix = switchShellPrefix(target, proxy);
    const panes: PaneAgentResult[] = [];
    for (const t of targets) {
      panes.push({ target: t.pane.target, outcome: await switchPane(deps, s.container, t.pane, t.proc, target, prefix) });
    }

    if (!panes.some((p) => p.outcome === "restarted")) return { status: "failed", panes };

    setSessionAgent(deps.db, sessionId, target);
    // The remembered repo choice: the swap is an explicit user choice, just like
    // `--agent` on open — the next session over this repo starts on the new
    // profile (and a reopen of THIS session does not do a silent recreate back to the old one).
    setRepoAgent(deps.db, s.folder, s.project, s.solo ? "claudeSolo" : s.repo, target, deps.now());
    logEvent(deps.db, sessionId, "agent-switch-live", { from, to: target, panes });
    return { status: "switched", panes };
  } finally {
    deps.inFlight.delete(sessionId);
  }
}
