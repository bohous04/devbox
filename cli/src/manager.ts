import { confirm, isCancel, log, outro, updateSettings } from "@clack/prompts";
import { createInterface } from "node:readline/promises";
import { sanitizeSessionName, type AgentName } from "../../devd/src/db";
import { sh } from "./sh";
import { killSessionCmd, parseProbe, tmuxLabel, type TmuxSession } from "../../devd/src/tmux";
import type { SessionInfo } from "./api";
import { agentLabel, buildExecArgv, capturePaneArgv, labelSetCmd, probeArgv } from "./attach";
import { clearScreen, endEffect, endPrompt, sessionLabel } from "./format";
import { attachTo, type Deps, endSoloInteractive, pickAndOpen, pickAndSwitchAgent, requireTty, selectVal } from "./main";
import { activityHint, browseOptions, type DetailAction, detailActions, landingOptions, MANAGER_BACK, MANAGER_BROWSE, MANAGER_NEW, MANAGER_QUIT, MANAGER_WHOLE, runningSessions, subDetailActions, subSessionOptions, type SubAction, trimPreview } from "./manager-view";

// Read-only snapshot of the session's last screen. A failure (tmux `main` does not exist,
// container unreachable, spawn error) is swallowed → "" → the caller shows
// "preview unavailable"; Attach then revives the session via the guard in tmuxCommand anyway.
function safeCapture(deps: Deps, container: string, session = "main"): string {
  try {
    const r = sh(process.cwd(), ...capturePaneArgv(deps.cfg, container, session));
    return r.code === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}

// Detail of a running session: a container with several Claudes expands into a list of sub-sessions,
// otherwise (0/1 tmux session) today's flat behavior (containerDetail).
async function sessionDetail(deps: Deps, s: SessionInfo): Promise<void> {
  const sessions = parseProbe(safeProbe(deps, s.container));
  if (sessions.length > 1) return subSessionList(deps, s);
  return containerDetail(deps, s, false);
}

// List of Claudes inside a container (>1 session). Loop: re-probe after an action. If the
// count drops below 2 (last Claude ended), it falls to containerDetail and returns to the list.
// "⚙ Whole session" → container-level actions. Backspace/Esc/"← Back" → one level up.
// Creating another window from here is not possible — it is just a signpost of where to attach.
async function subSessionList(deps: Deps, s: SessionInfo): Promise<void> {
  for (;;) {
    const sessions = parseProbe(safeProbe(deps, s.container));
    if (sessions.length <= 1) return containerDetail(deps, s, false);
    clearScreen();
    const header = `${sessionLabel(s)} · ${sessions.length} Claude`;
    const choice = await selectVal<string>(header, subSessionOptions(sessions));
    if (choice === undefined || choice === MANAGER_BACK) return;
    if (choice === MANAGER_WHOLE) return containerDetail(deps, s, true);
    const target = sessions.find((t) => t.name === choice);
    if (target) await subSessionDetail(deps, s, target);
  }
}

// Detail of one Claude: read-only preview of THIS tmux session + actions. Attach = direct mirror
// onto that session. Rename = @devd_label via docker exec. End = kill-session of that
// Claude (called only with >1 session; the last Claude drops subSessionList into
// containerDetail, where the whole session is ended). Always returns to subSessionList.
async function subSessionDetail(deps: Deps, s: SessionInfo, target: TmuxSession): Promise<void> {
  clearScreen();
  const label = tmuxLabel(target);
  const header = `${target.name}${label ? ` · ${label}` : ""} — ${s.project}/${s.repo}`;
  const lines = trimPreview(safeCapture(deps, s.container, target.name));
  if (lines.length) log.message(`preview (read-only) ${target.name}:\n${lines.join("\n")}`);
  else log.warn("preview unavailable");

  const action = await selectVal<SubAction>(header, subDetailActions());
  if (action === undefined || action === "back") return;
  if (action === "attach") { await attachTo(deps, s.container, target.name); return; }
  if (action === "rename") { await renameTmuxTarget(deps, s, target); return; }
  // "kill":
  const ok = await confirm({ message: `End ${target.name}${label ? ` (${label})` : ""}? Permanent, workspace stays.` });
  if (isCancel(ok) || !ok) return;
  sh(process.cwd(), ...buildExecArgv(deps.cfg, s.container, killSessionCmd(target.name), false));
  log.success(`Ended: ${target.name}`);
}

// Renaming a specific tmux session (no picker — we already know the target). Shares promptName
// + labelSetCmd with today's renameTmuxSession.
async function renameTmuxTarget(deps: Deps, s: SessionInfo, target: TmuxSession): Promise<void> {
  const answer = await promptName(`Name for ${target.name} (empty = clear label): `, target.label);
  if (answer === undefined) return;
  const name = sanitizeSessionName(answer);
  sh(process.cwd(), ...buildExecArgv(deps.cfg, s.container, labelSetCmd(target.name, name), false));
  log.success(name ? `${target.name} → "${name}"` : `Label cleared (${target.name})`);
}

// Detail of the whole session (container). `whole=false` = we came straight from the list to
// ONE session → read-only preview + Attach + Rename + End. `whole=true` = we came
// from expanding a container with several Claudes ("⚙ Whole session") → only container-level actions
// (Rename nickname, End whole session), WITHOUT preview and WITHOUT Attach — those belong to one Claude
// and are handled in its detail. Backspace/Esc = clack cancel → back.
async function containerDetail(deps: Deps, s: SessionInfo, whole: boolean): Promise<void> {
  clearScreen();
  const repo = `${s.project}/${s.repo}`;
  const title = sessionLabel(s);
  const header = `${title}${title !== repo ? ` (${repo})` : ""} · ${activityHint(s, Date.now())}`;
  if (!whole) {
    const lines = trimPreview(safeCapture(deps, s.container));
    if (lines.length) log.message(`preview (read-only):\n${lines.join("\n")}`);
    else log.warn("preview unavailable");
  }

  // "Whole session" = this container with all the agent windows in it, NOT all sessions
  // of the repo — there may be several and `api.end` touches only this one.
  const endLabel = whole ? "End session (all agent windows in it)" : "End session (permanent)";
  const action = await selectVal<DetailAction>(header, detailActions(!whole, { endLabel, agentNow: agentLabel(s.agent) }));
  if (action === undefined || action === "back") return;
  if (action === "attach") { await attachTo(deps, s.container); return; }
  if (action === "rename") { await renameSession(deps, s); return; }
  // The swap is container-level (DEVD_AGENT is shared by all windows) — hence here, not
  // in the detail of one Claude. After the result, back to the list (re-probe shows the new state).
  if (action === "agent") { await pickAndSwitchAgent(deps, s); return; }
  // "end": for claudeSolo the shared keep/delete/gist flow (has its own confirmation), otherwise
  // confirmation + ending the whole session (the container = all Claudes in it).
  if (s.solo) { await endSoloInteractive(deps, s); return; }
  // What happens to the files is told by endEffect — for a worktree session `end()` is destructive
  // (deletes its working directory including uncommitted changes), for the old shared
  // workspace it is not. The confirmation and the message after it must say the same, otherwise one of them lies.
  const ok = await confirm({ message: endPrompt(s.id, { whole, worktree: !!s.worktree }) });
  if (isCancel(ok) || !ok) return;
  await deps.api.end(s.id);
  // Id, not repo: with several sessions on one repo, "Ended: shop/cms" would not tell
  // which one disappeared (same reason as for `dev end` in main.ts).
  log.success(`Ended: ${s.id} — ${endEffect(!!s.worktree)}.`);
}

// Text prompt with a prefill. NOTE: deliberately NOT clack text() — the manager has a global alias
// backspace→cancel (for "back" in menus), which clack applies to text() as well (cancel detection
// is not gated on _track), so Backspace in text() would cancel the prompt instead of deleting a character.
// readline has its own line editor (Backspace deletes) and the clack alias does not affect it.
// Ctrl-C/EOF: readline in raw mode without a SIGINT listener only calls close() on Ctrl-C and
// the question() promise NEVER resolves (the whole `dev` would hang). So we abort ourselves.
// Returns undefined on cancel (no change), otherwise the raw answer.
export async function promptName(question: string, prefill?: string | null): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ac = new AbortController();
  rl.on("SIGINT", () => ac.abort());   // Ctrl-C → cancel prompt
  rl.once("close", () => ac.abort());  // Ctrl-D / EOF → same
  try {
    const q = rl.question(question, { signal: ac.signal });
    if (prefill) rl.write(prefill);
    return await q;
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
}

// Rename the CONTAINER: optional nickname for display (otherwise project/repo). Empty
// input clears the nickname. Client and server use the same sanitizeSessionName.
async function renameSession(deps: Deps, s: SessionInfo): Promise<void> {
  const repo = `${s.project}/${s.repo}`;
  const answer = await promptName(`Name for ${repo} (empty = clear nickname): `, s.name);
  if (answer === undefined) return;
  const name = sanitizeSessionName(answer);
  await deps.api.setName(s.id, name ?? "");
  log.success(name ? `Renamed to "${name}"` : `Nickname cleared (${repo})`);
}

// Read-only probe of tmux sessions. A failure (container unreachable, tmux server not running,
// spawn error) is swallowed → "" → the caller shows "no session".
function safeProbe(deps: Deps, container: string): string {
  try {
    const r = sh(process.cwd(), ...probeArgv(deps.cfg, container));
    return r.code === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}

// List of running sessions (2nd landing choice). Loop — after Enter on a session it shows the
// detail, after returning it re-renders the list from a fresh /api/sessions. "← Back",
// Backspace and Esc (clack cancel) → one level up to the landing menu.
async function browseSessions(deps: Deps): Promise<void> {
  for (;;) {
    clearScreen();
    const running = runningSessions(await deps.api.sessions());
    const choice = await selectVal<string>(`Running sessions (${running.length})`, browseOptions(running, Date.now()));
    if (choice === undefined || choice === MANAGER_BACK) return;
    const s = running.find((r) => r.id === choice);
    if (s) await sessionDetail(deps, s);
  }
}

// `dev` without arguments: interactive session manager. Landing menu: "➕ New session"
// (1st), "▶ Running sessions" (2nd — expands the list), "⏹ Quit". Backspace = one level
// back (mapped to clack "cancel"; does not override Esc/Ctrl-C): in the list/detail it jumps
// up, in the landing menu it exits `dev`. The loop runs until the user picks Quit/Backspace in the landing menu.
export async function sessionManager(deps: Deps, forced?: AgentName): Promise<number> {
  if (!requireTty()) return 1;
  updateSettings({ aliases: { backspace: "cancel" } });
  for (;;) {
    clearScreen();
    const running = runningSessions(await deps.api.sessions());
    const choice = await selectVal<string>("Devbox — what do you want to do?", landingOptions(running.length));
    if (choice === undefined || choice === MANAGER_QUIT) { outro("Quit."); return 0; }
    if (choice === MANAGER_NEW) { await pickAndOpen(deps, undefined, forced); continue; }
    if (choice === MANAGER_BROWSE) await browseSessions(deps);
  }
}
