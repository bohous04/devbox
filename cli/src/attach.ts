import { specFor } from "../../devd/src/agents";
import { labelSetCmd, probeCmd, singleQuote, tmuxLabel, type TmuxSession } from "../../devd/src/tmux";
import type { CliConfig } from "./config";
import { safeTmuxSession } from "./recovery";
import { warpBlockOption, warpGrokOption } from "./warp";

// Identity of the green bar (status-left) = project/repo from the devd env. The entrypoint
// does set it when the container starts, but an OLD image (whose baked tmux.conf did not
// have status-left/-length yet) or a tmux server created differently (web terminal) lose
// it → tmux default `[session]`; on top of that `status-left-length` defaults to 10, so
// even with the value set, ` project/repo | ` gets truncated and `|` disappears. So on EVERY
// attach we self-heal both from env (idempotent): the length (unconditionally) and the value
// (guard `-n "$DEVD_PROJECT"` as in the entrypoint — an empty env leaves an already correct
// global alone). 2>/dev/null: harmless when the server/option is missing.
const IDENTITY =
  'tmux set -g status-left-length 40 2>/dev/null; '
  // Same self-heal as for status-left: running containers still have in their baked tmux.conf
  // the old `set-titles-string "#{pane_title}"`, which ignores a manual label.
  + 'tmux set -g set-titles on 2>/dev/null; '
  + 'tmux set -g @devd_session_name "$DEVD_SESSION_NAME" 2>/dev/null; '
  + 'tmux set -g set-titles-string "#{?@devd_label,#{@devd_label},#{?@devd_session_name,#{@devd_session_name},#{?@devd_auto_title,#{@devd_auto_title},#{pane_title}}}}" 2>/dev/null; '
  + '[ -n "$DEVD_PROJECT" ] && tmux set -g status-left " $DEVD_PROJECT/${DEVD_REPO:-} | " 2>/dev/null';

// Exit key: F9 without the tmux prefix (`-n`). `detach-client -E` detaches this client
// and replaces its process with `exit 42` → code 42 falls through bash → docker exec → ssh to the mac,
// where attachLoop recognizes it and shows the exit menu. Per client: F9 in main-2 does not drop the client
// attached to main. Bound on EVERY attach (same self-heal as IDENTITY), so it
// also works on containers running from an older image. 2>/dev/null: harmless when the binding already exists.
export const EXIT_KEY = 'tmux bind-key -n F9 detach-client -E "exit 42" 2>/dev/null';

// tmux session launcher; agent-launch takes the container default ($DEVD_AGENT).
// The argument with a specific profile was here for `dev -n` (mixing Claude + Codex in one
// container via another tmux window) — it ended together with it: a second session today is
// its own container with its own $DEVD_AGENT.
// Fallback to `claude-launch`: an OLD image (before this branch) has no `agent-launch` — only
// `claude-launch`. After a deploy the old image keeps running until the container is recreated, and
// this path also CREATES a tmux session that does not exist yet (guard `has-session ||
// new-session -d`: the first attach to `main` in a fresh container), not just attaches
// to a running one.
// Without the fallback `agent-launch` would fail with exit 127 on an old container and take down the whole
// tmux session.
export function launchCmd(): string {
  return `-c /workspace sh -lc 'if [ -x /usr/local/bin/agent-launch ]; then exec /usr/local/bin/agent-launch; else exec /usr/local/bin/claude-launch; fi'`;
}

// Attach to a SPECIFIC persistent session (default `main`): the guard creates/revives it
// detached, then the identity is filled in and the ONLY command of the chain allowed to attach is
// the final `tmux attach`.
//
// The guard is `has-session || new-session -d`, NOT the former `new-session -A -d`. `-A`
// behaves like attach-session on an EXISTING session and ignores `-d` in that case —
// so the terminal attached already with the FIRST command of the chain and the rest (identity, F9 binding,
// final attach) waited unexecuted. That was the whole "F9 needs two presses" mystery:
//   1st press → detach-client detached the client from `new-session -A`; its `exit 42`, however,
//   got lost in the middle of the chain (`;`) and bash went on — the final `tmux attach` reattached the terminal
//   IMMEDIATELY, so from the outside "nothing happened". Only the 2nd press detached
//   the last client of the chain, whose code 42 is also the code of the whole bash → ssh → dev.
// Measured on a live container (ps: the first command of the chain hung attached for 28 minutes;
// after the 1st press it was replaced by `tmux attach -d`). Hence the REGRESSION rule: before the final
// `attach` nothing in the chain may be able to attach.
//
// `=` in `-t =<session>`: exact name match. Without it tmux also matches by prefix, so
// with a dead `main` and a live `main-2` the guard and the attach would silently grab `main-2`;
// with `=` `main` is correctly created.
//
// `attach -d` (detaches the other clients) is here because of ORPHANED attach processes: when
// ssh dies or a Warp tab is closed, `docker exec … tmux attach` inside the container survives and
// keeps hanging as an attached client. Five of them were measured there at once. They pile up
// the longer the container runs, and they cannot be reliably told apart from the live client.
// The cost of `-d`: `dev` no longer mirrors from here — a second attach to the same session detaches
// the first.
export function tmuxCommand(session = "main", grokSupport?: boolean, existingOnly = false): string {
  if (!safeTmuxSession(session)) throw new Error("Invalid tmux session name");
  const missing = existingOnly ? "exit 44" : `tmux new-session -d -s ${session} ${launchCmd()}`;
  const warp = [warpGrokOption(grokSupport, session), warpBlockOption(grokSupport, session)]
    .filter(Boolean).map((cmd) => cmd + "; ").join("");
  return `tmux has-session -t =${session} 2>/dev/null || ${missing}; ${IDENTITY}; ${sessionTitleCommand(session)}; ${EXIT_KEY}; ${warp}tmux attach -d -t =${session}`;
}

// One probe = list of sessions + labels + number of attached clients. Non-interactive;
// non-zero exit (tmux server not running) → empty output → caller = no sessions.
export function probeArgv(cfg: CliConfig, container: string): string[] {
  return buildExecArgv(cfg, container, probeCmd(), false);
}


/** Profile label. A function, not a table: the key is almost always a value from the DB or
 *  from the tmux probe, i.e. plain text — indexing a table would, for an unknown value,
 *  silently return `undefined` and that would make it all the way into a user-facing sentence. */
export const agentLabel = (agent: string | null | undefined): string => specFor(agent).label;

// Options for the attach picker: mirror main + attach each extra session. If a session has
// an agent and/or a label (manual or Claude title), it is appended after the name. Creating another
// window from here is NOT possible: "another session" today means its own container with its own worktree
// (handled by the "Attach / New session" menu in pickAndOpen), and another window over the same files
// tmux and the agent open by themselves. A container may still have windows from earlier, so the list stays.
export function sessionPickerOptions(sessions: TmuxSession[]): { value: string; label: string }[] {
  const withMeta = (base: string, s?: TmuxSession) => {
    const parts = [base];
    if (s?.agent) parts.push(agentLabel(s.agent));
    const l = s ? tmuxLabel(s) : null;
    if (l) parts.push(l);
    return parts.join(" · ");
  };
  const main = sessions.find((s) => s.name === "main");
  return [
    { value: "main", label: withMeta("Attach to main", main) },
    ...sessions.filter((s) => s.name !== "main").map((s) => ({ value: s.name, label: withMeta(`Attach to ${s.name}`, s) })),
  ];
}

// Config for the BACKUP network path = the same one, only `sshHost` swapped for `sshHostAlt`
// (ssh alias to the tailnet address). Thanks to that, all the argv builders (attach, probe, capture)
// can run over the second route without changing their API. `undefined` = alt is not configured
// (or local docker mode) → the caller stays on the single path.
export function altCfg(cfg: CliConfig): CliConfig | undefined {
  return cfg.sshHost && cfg.sshHostAlt ? { ...cfg, sshHost: cfg.sshHostAlt } : undefined;
}
// container → ssh alias of the InstaBox machine (from /api/sessions `dockerHost`). Attach goes via
// the VPS: `ssh vps docker -H ssh://ibx-… exec …` — devd on the VPS holds the host block, the mac does not
// need to configure anything. Filled by ApiClient.sessions(); empty map = everything on the VPS.
const dockerHosts = new Map<string, string>();
export function rememberDockerHosts(sessions: { container: string; dockerHost?: string | null }[]): void {
  for (const s of sessions) { if (s.dockerHost) dockerHosts.set(s.container, s.dockerHost); else dockerHosts.delete(s.container); }
}
export function dockerExecPrefix(container: string): string {
  const h = dockerHosts.get(container);
  return h ? `docker -H ssh://${h}` : "docker";
}

export function buildExecArgv(cfg: CliConfig, container: string, remoteCmd: string, interactive = true): string[] {
  if (cfg.sshHost) {
    const flags = interactive ? "-it " : "";
    const docker = `${dockerExecPrefix(container)} exec ${flags}${container} bash -lc ${singleQuote(remoteCmd)}`;
    // Keepalive: without it a dropped connection is noticed only at the TCP timeout (tens of seconds to minutes).
    // ServerAlive* 5×3 → dead connection within ~15 s; ConnectTimeout prevents hanging ~75 s on reconnect.
    const keepalive = ["-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10"];
    return interactive
      ? ["ssh", "-t", ...keepalive, cfg.sshHost, docker]
      : ["ssh", ...keepalive, cfg.sshHost, docker];
  }
  if (dockerHosts.has(container)) throw new Error("InstaBox sessions need sshHost (attach goes through the VPS)");
  const base = interactive ? ["docker", "exec", "-it"] : ["docker", "exec"];
  return [...base, container, "bash", "-lc", remoteCmd];
}

// Read-only snapshot of the session's last screen for the preview in the manager: `capture-pane -p`
// = plain text without ANSI, `-t main` = grouped session from the entrypoint, `-S -40` =
// last ~40 lines including scrollback. Non-interactive (no -it / ssh -t);
// a non-zero exit (tmux `main` does not exist / container unreachable) is handled by the caller.
export function capturePaneArgv(cfg: CliConfig, container: string, session = "main"): string[] {
  return buildExecArgv(cfg, container, `tmux capture-pane -p -t ${session} -S -40 2>/dev/null`, false);
}

export async function runInteractive(argv: string[], cwd?: string, env?: Record<string, string | undefined>): Promise<number> {
  const p = Bun.spawn(argv, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await p.exited;
}

export { labelSetCmd, singleQuote };

// Nickname from the API into the remote shell. A separate option keeps the tmux sessions'
// own labels; an empty value removes the old nickname on the next attach.
export function withSessionName(command: string, name?: string | null): string {
  const title = (name ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  return `export DEVD_SESSION_NAME=${singleQuote(title)}; ${command}`;
}

// Local hook settings take precedence over global ones; on resume we fix those too.
export function sessionTitleCommand(session: string): string {
  return `tmux set -t ${session} set-titles on 2>/dev/null; tmux set -t ${session} set-titles-string "#{?@devd_label,#{@devd_label},#{?@devd_session_name,#{@devd_session_name},#{?@devd_auto_title,#{@devd_auto_title},#{pane_title}}}}" 2>/dev/null`;
}
