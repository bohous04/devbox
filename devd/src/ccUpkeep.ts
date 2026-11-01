// Automatic Claude Code update in the devbox: once a day, in the night window, detect a
// new version, rebuild the image with --build-arg CC_VERSION and also install it into
// running containers that are currently idle (restart cc via /exit +
// `cc --resume <id of that conversation>`, so the conversation continues).
//
// The decision part is deliberately free of I/O — it is tested without docker, just as
// sweepIdleSessions has an injected ActivityProbe.

import type { Database } from "bun:sqlite";
import type { NotifyFn } from "./agentEvents";
import type { Settings } from "./config";
import { listSessions, logEvent, type SessionRow } from "./db";

// `claude --version` returns "2.1.202 (Claude Code)", `npm view … version` a bare "2.1.220".
export function parseCcVersion(raw: string): string | null {
  const m = raw.trim().match(/^(\d+\.\d+\.\d+)/);
  return m ? m[1]! : null;
}

// Numeric comparison: as strings "2.1.9" > "2.1.10".
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0; const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// Upper bound exclusive; startHour > endHour means the window spans midnight.
export function inWindow(d: Date, startHour: number, endHour: number): boolean {
  const h = d.getHours();
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

// 20 h (not 24) — the window is only two hours wide; exactly 24 h would, with tick drift,
// drop out every other day.
export function dueForCheck(lastRunAt: number | null, now: number): boolean {
  return lastRunAt === null || now - lastRunAt >= 20 * 3600_000;
}

export interface CcUpkeepSettings { enabled: boolean; windowStartHour: number; windowEndHour: number }

const CC_UPKEEP_DEFAULTS: CcUpkeepSettings = { enabled: true, windowStartHour: 3, windowEndHour: 5 };

// Missing fields get defaults — old configs without `ccUpkeep` remain valid.
export function resolveCcUpkeep(s: Settings): CcUpkeepSettings {
  return { ...CC_UPKEEP_DEFAULTS, ...(s.ccUpkeep ?? {}) };
}

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }

export interface UpkeepDeps {
  db: Database;
  // docker exec into the session container
  exec: (container: string, cmd: string[], timeoutMs: number) => Promise<ExecResult>;
  // process on the host (npm view, docker build, docker run)
  host: (cmd: string[], timeoutMs: number) => Promise<ExecResult>;
  turnInProgress: (sessionId: string) => boolean;
  notify: NotifyFn;
  sleep: (ms: number) => Promise<void>;
  repoDir: string;   // /opt/vps-dev-infra — the image is built from here
  image: string;     // devbox:latest
}

// cc load is measured by SAMPLING, not via `ps %cpu`: that is the average over the whole
// process lifetime, so a session that once worked hard looks busy forever, and vice versa.
// Measured live on the VPS (utime+stime delta over 3 s, 100 ticks = 1 % of a core):
//   idle cc (TUI overhead only) …… 1–7 % of a core
//   working cc …………………… 50–65 % of a core
// The 3 % threshold from watchdog.ts is therefore BELOW the idle floor — harmless for
// auto-stop (it is only a veto against stopping), but here it would keep the probe "busy" forever.
// Output: the highest measured percentage across running claude processes (0 if none runs).
export const BUSY_SAMPLE_MS = 2000;
export const BUSY_THRESHOLD_PCT = 25;   // with margin above the idle ceiling and below working load
// Prints `pid pct` for every running claude. Per pid (not just the maximum), because restarting
// one pane spins up a new cc that briefly burns above the threshold — and that must not block
// the other panes; each is judged by its own subtree.
export const BUSY_CLAUDE = `before=""
for p in $(pgrep -x claude 2>/dev/null); do before="$before $p:$(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null || echo 0)"; done
sleep 2
for e in $before; do
  p=\${e%%:*}; a=\${e#*:}
  b=$(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null || echo "$a")
  echo "$p $(( (b - a) * 100 / 200 ))"
done`;

// pid → % of a core. Empty output (no claude) = empty map = idle.
// An unreadable line is dropped; null means "the output makes no sense" → cautiously "busy".
export function parseBusySamples(raw: string): Map<number, number> | null {
  const out = new Map<number, number>();
  const t = raw.trim();
  if (t === "") return out;
  for (const line of t.split("\n")) {
    const [p, pct] = line.trim().split(/\s+/);
    const pid = Number.parseInt(p ?? "", 10);
    const n = Number.parseInt(pct ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(n) || n < 0) return null;
    out.set(pid, n);
  }
  return out;
}

async function sampleBusy(deps: UpkeepDeps, container: string): Promise<Map<number, number> | null> {
  const r = await deps.exec(container, ["sh", "-c", BUSY_CLAUDE], 15_000 + BUSY_SAMPLE_MS);
  if (r.code !== 0 || r.timedOut) return null;   // unreachable container → do not touch
  return parseBusySamples(r.stdout);
}

// Idleness of the whole session — the gate before install, which touches the whole container.
export async function isQuiet(deps: UpkeepDeps, s: SessionRow): Promise<boolean> {
  if (deps.turnInProgress(s.id)) return false;
  const samples = await sampleBusy(deps, s.container);
  if (!samples) return false;
  return [...samples.values()].every((pct) => pct < BUSY_THRESHOLD_PCT);
}

// Idleness of one pane — the gate before restarting it. Looks only at claude in its own
// subtree, so a neighbouring pane that is spinning up blocks nobody.
// It reads a fresh process table: the operator may have restarted cc in the pane in the
// meantime, and the old pid would look idle.
export async function isPaneQuiet(deps: UpkeepDeps, s: SessionRow, pane: Pane): Promise<boolean> {
  if (deps.turnInProgress(s.id)) return false;
  const ps = await deps.exec(s.container, PS_TREE_CMD, 15_000);
  if (ps.code !== 0 || ps.timedOut) return false;
  const samples = await sampleBusy(deps, s.container);
  if (!samples) return false;
  return claudeProcsUnder(pane.pid, parseProcTree(ps.stdout))
    .every((c) => (samples.get(c.pid) ?? 0) < BUSY_THRESHOLD_PCT);
}

export interface Pane { target: string; pid: number }
export interface Proc { pid: number; ppid: number; etimes: number; comm: string }

// `-a` = across all tmux sessions in the container (main, main-2, …). The target is already
// in the form `send-keys -t` accepts; pid is the root of the pane's process tree.
export const PANES_CMD = ["tmux", "list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}"];

// A live cc is looked up in the pane's process tree, NOT via `#{pane_current_command}`:
// claude-launch.sh starts `cc` as a child (`exec zsh` only after it ends), so a pane
// with a live cc reports "bash". Verified live on the VPS — the check via that field found
// claude in 2 containers out of 6, the process tree in all 6.
//
// Pane detection and the wait in restartClaudePane must use the SAME signal. If they
// diverged, the wait after `/exit` would immediately see "bash", conclude cc had ended, and
// the launch command would be typed as a prompt into the middle of a live conversation.
// `etimes` = how many seconds the process has been running; used for comparison with the
// binary's age (see BIN_AGE_CMD and stalePanes).
export const PS_TREE_CMD = ["ps", "-eo", "pid=,ppid=,etimes=,comm="];

// Age of the installed cc binary in seconds. A restart is needed even where the disk has
// long been up to date — the binary may have been upgraded by cc's own auto-updater or a
// manual `npm i -g`, while panes keep running code that is no longer on disk. Caught
// live: portal had 2.1.220 from 25 Jul 14:19 on disk, but two of three panes were
// running from 20 Jul and 25 Jul 13:50 — the job skipped them then because the version matched.
export const BIN_AGE_CMD = ["sh", "-c",
  `echo $(( $(date +%s) - $(stat -c %Y "$(npm root -g)/@anthropic-ai/claude-code/package.json") ))`];

export function parsePanes(raw: string): Pane[] {
  const out: Pane[] = [];
  for (const line of raw.split("\n")) {
    const [target, pid] = line.split("\t");
    const n = Number.parseInt((pid ?? "").trim(), 10);
    if (!target?.trim() || !Number.isInteger(n)) continue;
    out.push({ target: target.trim(), pid: n });
  }
  return out;
}

export function parseProcTree(raw: string): Proc[] {
  const out: Proc[] = [];
  for (const line of raw.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const pid = Number.parseInt(f[0]!, 10);
    const ppid = Number.parseInt(f[1]!, 10);
    const etimes = Number.parseInt(f[2]!, 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(etimes)) continue;
    out.push({ pid, ppid, etimes, comm: f.slice(3).join(" ") });
  }
  return out;
}

// Processes with the given names in the pane's subtree. Searched transitively (pane → bash →
// agent → …); `seen` keeps the traversal finite even over a corrupted process table
// (ppid cycle). Names = runtimes from AGENTS_TABLE (claude/codex/grok) — the agent
// swap (agentSwitch.ts) needs to find non-claude agents too.
export function agentProcsUnder(pid: number, procs: Proc[], comms: readonly string[]): Proc[] {
  const found: Proc[] = [];
  const self = procs.find((p) => p.pid === pid);
  if (self && comms.includes(self.comm)) found.push(self);
  const byParent = new Map<number, Proc[]>();
  for (const p of procs) {
    const arr = byParent.get(p.ppid);
    if (arr) arr.push(p); else byParent.set(p.ppid, [p]);
  }
  const seen = new Set<number>([pid]);
  const queue = [...(byParent.get(pid) ?? [])];
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    if (comms.includes(p.comm)) found.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return found;
}

export function claudeProcsUnder(pid: number, procs: Proc[]): Proc[] {
  return agentProcsUnder(pid, procs, ["claude"]);
}

export function hasClaudeUnder(pid: number, procs: Proc[]): boolean {
  return claudeProcsUnder(pid, procs).length > 0;
}

// `/proc/<pid>/environ` is a NUL-separated list of `KEY=VALUE`, not line-based like
// `ps` output — `cat` prints it raw as is. accountSwitch.ts reads the pane's
// CLAUDE_CONFIG_DIR from it to tell whether the pane is (or is not) already on the
// target account; the function only asks for ONE specific key and does not copy the rest
// of the environ anywhere (it may carry secret variables).
export function envVarFromProcEnviron(raw: string, key: string): string | null {
  for (const pair of raw.split("\0")) {
    const i = pair.indexOf("=");
    // `i > 0`, not `>= 0`: the key must not be empty. Comparing the whole part BEFORE "="
    // (not `pair.startsWith(key)`) prevents matching a key that has the searched one as
    // a mere suffix (e.g. "MY_CLAUDE_CONFIG_DIR").
    if (i > 0 && pair.slice(0, i) === key) return pair.slice(i + 1);
  }
  return null;
}

// A pane is stale when its claude has been running LONGER than the binary on disk is old —
// i.e. it started on the previous version. Independent of whether this job
// installed anything just now: anyone may have replaced the binary (cc auto-updater, manual
// `npm i -g`, a previous job run that did not restart the pane).
export function stalePanes(panes: Pane[], procs: Proc[], binAgeSec: number): Pane[] {
  return panes.filter((p) => claudeProcsUnder(p.pid, procs).some((c) => c.etimes > binAgeSec));
}

// A pane restart needs only exec+sleep, not the whole UpkeepDeps (db, host,
// turnInProgress, notify, …) — accountSwitch.ts (account switch `dev switch`) shares
// this and has no reason to fabricate the rest of UpkeepDeps just to satisfy the types.
export type RestartDeps = Pick<UpkeepDeps, "exec" | "sleep">;

// Waits until the pane's subtree contains (want=true) / does not contain (want=false) a process
// with one of the given names. An unreadable process table is not the answer "already ended" —
// it is retried in the next round. Exported for agentSwitch.ts (also waits for codex/grok).
export async function waitForProcs(
  deps: RestartDeps, container: string, pid: number, comms: readonly string[], want: boolean, timeoutMs: number,
): Promise<boolean> {
  const step = 1000;
  for (let waited = 0; waited < timeoutMs; waited += step) {
    await deps.sleep(step);
    const r = await deps.exec(container, PS_TREE_CMD, 10_000);
    if (r.code !== 0 || r.timedOut) continue;
    if ((agentProcsUnder(pid, parseProcTree(r.stdout), comms).length > 0) === want) return true;
  }
  return false;
}

// After `/exit`, waits until either (a) claude disappears from the pane's subtree (exited
// cleanly), or (b) the cc 2.1.260 dialog about unfinished background work appears. Both are
// checked in EVERY round, not one first and then the other — the dialog can appear
// at any point in the window, and waiting for the claude outcome first would add up to
// 30 s of needless delay to recognising it.
const EXIT_DIALOG_GONE_WAIT_MS = 5_000;

async function waitForExitOrDialog(
  deps: RestartDeps, container: string, pane: Pane, timeoutMs: number,
): Promise<"exited" | "dialog" | "timeout"> {
  const step = 1000;
  for (let waited = 0; waited < timeoutMs; waited += step) {
    await deps.sleep(step);
    const ps = await deps.exec(container, PS_TREE_CMD, 10_000);
    if (ps.code === 0 && !ps.timedOut && !hasClaudeUnder(pane.pid, parseProcTree(ps.stdout))) return "exited";
    const text = await paneText(deps, container, pane.target);
    if (text !== null && exitDialogShown(text)) return "dialog";
  }
  return "timeout";
}

// After Escape the pane gets a few seconds for the dialog to actually close — just for calm, so
// the launch command in later calls (accountSwitch/agentSwitch read the pane right
// after the restart) does not meet a dialog that is still rendering. The result is not
// used anywhere: restartPane returns "did-not-exit" either way (see below).
async function waitForExitDialogGone(
  deps: RestartDeps, container: string, target: string, timeoutMs: number,
): Promise<boolean> {
  const step = 1000;
  for (let waited = 0; waited < timeoutMs; waited += step) {
    await deps.sleep(step);
    const text = await paneText(deps, container, target);
    if (text !== null && !exitDialogShown(text)) return true;
  }
  return false;
}

// cc 2.1.234 added an interactive prompt after `--continue` on a large session ("This session
// is X old and Y tokens… 1. Resume from summary / 2. Resume full session as-is /
// 3. Don't ask me again"). Previously `--continue` attached to the conversation directly, so
// "claude is running in the pane's subtree" was enough proof of success — and that condition
// is also met by a cc stuck on the dialog. Live on 18 Aug 2026: the job reported restarted:1 for six
// panes that then hung for 16.7 h on an unanswered prompt, and it was not visible anywhere.
//
// The answer is "Resume full session as-is" — exactly what `--continue` did before.
// The job restarts to swap the binary, not to touch the user's conversation content;
// a summary would irreversibly compress the context.
export const RESUME_DIALOG_MARK = "Resuming the full session will consume";
export const RESUME_CONFIRM_MARK = "Enter to confirm";
export const RESUME_FULL_LABEL = "Resume full session as-is";
export const RESUME_DIALOG_WAIT_MS = 30_000;
export const RESUME_GONE_WAIT_MS = 15_000;

export type ResumeDialogState =
  | { kind: "absent" }                 // no dialog in the pane
  | { kind: "unparsed" }               // there is one, but we do not understand the options → do not press blindly
  | { kind: "ready"; steps: number };  // how far to move the cursor (negative = up)

export const CAPTURE_CMD = (target: string) => ["tmux", "capture-pane", "-p", "-t", target];

// Option line: "  ❯ 2. Resume full session as-is" / "    1. Resume from summary…".
const OPTION_LINE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;

// Options are searched only between the message and the "Enter to confirm" footer. Above it is
// the transcript, where a numbered list — or a quote of that sentence, possibly from debugging
// this very bug — would otherwise shift the indices. And without the footer it is not a live
// dialog, just text: in that case nothing may be pressed in the pane.
export function resumeDialogState(paneText: string): ResumeDialogState {
  const lines = paneText.split("\n");
  const mark = lines.findLastIndex((l) => l.includes(RESUME_DIALOG_MARK));
  if (mark < 0) return { kind: "absent" };
  const confirm = lines.findIndex((l, i) => i > mark && l.includes(RESUME_CONFIRM_MARK));
  if (confirm < 0) return { kind: "absent" };

  const options = lines.slice(mark + 1, confirm)
    .map((l) => l.match(OPTION_LINE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ cursor: Boolean(m[1]), full: m[3]!.includes(RESUME_FULL_LABEL) }));

  const cursor = options.findIndex((o) => o.cursor);
  const full = options.findIndex((o) => o.full);
  if (cursor < 0 || full < 0) return { kind: "unparsed" };
  return { kind: "ready", steps: full - cursor };
}

// cc 2.1.260 added a dialog when leaving a pane that has unfinished background work
// (a running Bash tool, a background agent): instead of exiting after `/exit`, it shows
//   ❯ 1. Exit and stop tasks
//     2. Move to background and exit
//     3. Stay
//   Enter to confirm · Esc to cancel
// The nightly upkeep and the account/agent switch may only update the pane, not stop the
// user's unfinished work or silently send it to the background — so Esc ("Stay") is always
// chosen: the pane stays usable on the old cc version.
//
// The same caution as in resumeDialogState: it is not enough that the option/footer words
// appear SOMEWHERE in the pane — they must be in the right order (footer AFTER the last
// option), otherwise an old mention in the transcript (e.g. a quote while debugging
// this very bug) would look like a live dialog.
const EXIT_DIALOG_OPTIONS = ["Exit and stop tasks", "Move to background and exit", "Stay"];
export const EXIT_DIALOG_CONFIRM_MARK = "Enter to confirm";

export function exitDialogShown(paneText: string): boolean {
  const lines = paneText.split("\n");
  const optionLines = EXIT_DIALOG_OPTIONS.map((mark) => lines.findLastIndex((l) => l.includes(mark)));
  if (optionLines.some((i) => i < 0)) return false;
  const lastOption = Math.max(...optionLines);
  return lines.some((l, i) => i > lastOption && l.includes(EXIT_DIALOG_CONFIRM_MARK));
}

async function paneText(deps: RestartDeps, container: string, target: string): Promise<string | null> {
  const r = await deps.exec(container, CAPTURE_CMD(target), 10_000);
  return r.code === 0 && !r.timedOut ? r.stdout : null;
}

// true = the pane is usable: either the dialog did not appear, or we answered it.
// false means "stuck pane" — the caller reports it as `stuck-on-dialog` instead of
// letting the freeze hide under restarted:1.
export async function answerResumeDialog(
  deps: RestartDeps, container: string, pane: Pane,
): Promise<boolean> {
  const step = 1000;
  for (let waited = 0; waited < RESUME_DIALOG_WAIT_MS; waited += step) {
    await deps.sleep(step);
    const text = await paneText(deps, container, pane.target);
    if (text === null) continue;
    const state = resumeDialogState(text);
    if (state.kind === "absent") continue;      // not rendered yet, or never will be
    if (state.kind === "unparsed") return false;

    const key = state.steps >= 0 ? "Down" : "Up";
    for (let i = 0; i < Math.abs(state.steps); i++) {
      const r = await deps.exec(container, ["tmux", "send-keys", "-t", pane.target, key], 10_000);
      if (r.code !== 0 || r.timedOut) return false;
    }
    // The cursor is read again before Enter. Confirming blindly after an undelivered arrow
    // would hit "Resume from summary" and irreversibly compress the conversation.
    const after = await paneText(deps, container, pane.target);
    const check = after === null ? { kind: "unparsed" as const } : resumeDialogState(after);
    if (check.kind !== "ready" || check.steps !== 0) return false;

    const enter = await deps.exec(container, ["tmux", "send-keys", "-t", pane.target, "Enter"], 10_000);
    if (enter.code !== 0 || enter.timedOut) return false;
    return waitForDialogGone(deps, container, pane.target, RESUME_GONE_WAIT_MS);
  }
  return true;   // the dialog did not show during the whole window → `--continue` attached directly
}

async function waitForDialogGone(
  deps: RestartDeps, container: string, target: string, timeoutMs: number,
): Promise<boolean> {
  const step = 1000;
  for (let waited = 0; waited < timeoutMs; waited += step) {
    await deps.sleep(step);
    const text = await paneText(deps, container, target);
    if (text !== null && resumeDialogState(text).kind === "absent") return true;
  }
  return false;
}

// ── Which conversation the pane belongs to ──────────────────────────────────────────
// `cc --continue` MUST NOT be used. It means "the newest conversation in the current
// directory", but cwd is /workspace in all containers and `~/.claude/projects`
// is a symlink into the shared claude-home volume (verified live 21 Aug 2026), so
// "newest" is one global value for the WHOLE devbox — shared even across account
// profiles. The nightly upkeep restarts panes ~9 s apart, so each one took the
// previous one's conversation: on 21 Aug four containers ended up on one and the same
// conversation and also fought over Remote Control (code 4090). So the restart always
// targets a SPECIFIC id.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// The most reliable source: the argv of the live claude. A pane restarted by this code has
// `--resume <id>`, and `--resume` KEEPS the id (verified live — after the restart it keeps
// writing into the same `<id>.jsonl`), so after the first round it maintains itself.
// `--session-id` is here for panes started with a forced id.
export function parseSessionIdFromCmdline(raw: string): string | null {
  const argv = raw.split("\0");
  const re = new RegExp(`^${UUID}$`);
  for (let i = 0; i < argv.length - 1; i++) {
    if ((argv[i] === "--resume" || argv[i] === "-r" || argv[i] === "--session-id") && re.test(argv[i + 1]!)) {
      return argv[i + 1]!;
    }
  }
  return null;
}

// Fallback for panes started the old way (bare `cc`, `cc --continue`): on exit cc
// prints "Resume this session with: / claude --resume <id>". The pane history also holds
// OLD banners from past restarts, so the LAST one counts — it was just printed by the cc
// we have now terminated. That it is not stale is additionally checked by transcriptFreshCmd.
export function parseExitBannerId(paneText: string): string | null {
  const all = [...paneText.matchAll(new RegExp(`claude --resume (${UUID})`, "g"))];
  return all.length ? all[all.length - 1]![1]! : null;
}

// Does a transcript for that id exist and was it written just now? cc writes to the
// transcript on exit (measured live: file mtime = the second the pane received
// `/exit`), so freshness distinguishes the banner from THIS exit from a banner that was
// just left on screen after a past restart. Without it a pane with an empty conversation
// (cc has nothing to offer, prints no banner) would end up on a month-old conversation.
//
// `-L` is mandatory: in an account-pool profile (`~/.claude-accounts/<id>`) `projects` is a
// SYMLINK into the shared `~/.claude/projects` (link-shared-profile), and GNU find without
// -L/-H does not descend into a symlinked STARTING POINT — it returns nothing and zero, i.e.
// "transcript not written". On 3–4 Sep 2026 every fresh session (without `--resume`
// in argv, where the rescue id would be) thus ended up at a shell after the nightly restart as
// "unknown-session", although the transcript was right there and the banner was correct.
export function transcriptFreshCmd(configDir: string, id: string, maxAgeMin: number): string[] {
  return ["find", "-L", `${configDir}/projects`, "-name", `${id}.jsonl`, "-newermt", `-${maxAgeMin} minutes`, "-print", "-quit"];
}

export const TRANSCRIPT_FRESH_MIN = 5;

// The CURRENT source: cc keeps `<config dir>/sessions/<pid>.json` with the conversation the
// process is on RIGHT NOW — it follows an in-app `/resume` (verified live 1 Nov 2026: a pane
// started with `--resume 072160c6…` and switched by `/resume` showed `6a51bd44…` there while
// argv still said 072160c6). `procStart` (field 22 of /proc/<pid>/stat) rules out a file of
// ANOTHER process with the same pid: `sessions/` lives in the claude-home volume shared by all
// containers, each container has its own pid namespace, so the same pid recurs (verified live:
// two containers both ran claude as pid 295 and the file belonged to the other one) — and
// a stale file of an earlier process. Prints the id or fails; failure falls back to the banner.
export const CLAUDE_LIVE_SESSION = `# CLAUDE_LIVE_SESSION
import json, sys
pid, config = sys.argv[1:]
s = json.load(open(config + "/sessions/" + pid + ".json"))
start = open("/proc/" + pid + "/stat").read().rsplit(")", 1)[1].split()[19]
assert s["pid"] == int(pid) and str(s["procStart"]) == start
print(s["sessionId"])
`;

async function liveSessionId(deps: RestartDeps, container: string, claudePid: number, configDir: string): Promise<string | null> {
  try {
    const r = await deps.exec(container, ["python3", "-c", CLAUDE_LIVE_SESSION, String(claudePid), configDir], 10_000);
    const id = r.stdout.trim();
    return r.code === 0 && !r.timedOut && new RegExp(`^${UUID}$`).test(id) ? id : null;
  } catch { return null; }
}

// Does a transcript for that id exist at all (any age)? `null` = could not be determined.
async function transcriptExists(deps: RestartDeps, container: string, configDir: string, id: string): Promise<boolean | null> {
  const r = await deps.exec(container, ["find", "-L", `${configDir}/projects`, "-name", `${id}.jsonl`, "-print", "-quit"], 15_000);
  return r.code !== 0 || r.timedOut ? null : r.stdout.trim() !== "";
}

// Without an id a bare `cc` is launched — a conversation cc has nothing to restore from is
// empty, so nothing is lost. NEVER `--continue`.
export const ccResumeCmd = (id: string | null): string => (id === null ? "cc" : `cc --resume ${id}`);

// The real CLAUDE_CONFIG_DIR of the running claude process (not the pane/shell above it) —
// VERIFIED live on a running container: claude (pid 97) had
// CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/max20, while the pane root/shell
// above it (pid 85) still had /home/dev/.claude (the default from Dockerfile ENV).
// `/proc/<pid>/environ` is a snapshot from the MOMENT of exec, not live state — a later
// `export` in the shell is never reflected in it, so the shell keeps carrying the startup
// value and only the claude that agent-launch actually exported it to shows the
// truth. DO NOT SIMPLIFY to pane.pid.
//
// `null` = could not be read (the process vanished meanwhile, /proc unavailable, empty output)
// — the caller MUST treat it as "don't know", never as "different account" (see restartPanes).
export async function paneConfigDir(deps: RestartDeps, container: string, claudePid: number): Promise<string | null> {
  const r = await deps.exec(container, ["cat", `/proc/${claudePid}/environ`], 10_000);
  if (r.code !== 0 || r.timedOut || !r.stdout) return null;
  return envVarFromProcEnviron(r.stdout, "CLAUDE_CONFIG_DIR");
}

// The pane's nearest live claude (BFS from the pane root) — the one agent-launch.sh
// started, not a possible nested `claude` launched by the agent itself.
async function paneClaudePid(deps: RestartDeps, container: string, pane: Pane): Promise<number | null> {
  const r = await deps.exec(container, PS_TREE_CMD, 15_000);
  if (r.code !== 0 || r.timedOut) return null;
  return claudeProcsUnder(pane.pid, parseProcTree(r.stdout))[0]?.pid ?? null;
}

// The different restart outcomes are handled differently: "did-not-exit" is harmless (the pane
// keeps working on the old version, retried tomorrow), "did-not-return" needs
// human attention (pane without a live cc). The process itself cannot tell these two cases
// apart in advance — the session manager home screen and a regular conversation have a
// bit-identical command line, verified live on the VPS — so classification is by
// outcome, not by screen content.
// "stuck-on-dialog" is the fourth case, added after the 18 Aug 2026 incident: cc came back
// and runs, but sits on an unanswered resume prompt. It differs from "did-not-return" in
// what a human should do about it — there the pane sits at a bare shell, here it waits for a key.
// "unknown-session" is the fifth case: cc exited, but it could not be determined WHICH
// conversation the pane had. Restarting blindly via `--continue` is exactly the bug
// this code fixes, so the pane is rather left at the shell — on exit cc
// printed "Resume this session with: claude --resume <id>" there, so a human (or the
// next run) can manage.
// "did-not-exit" also covers cc 2.1.260 with the dialog about unfinished background work
// (a running Bash tool, an agent) — Esc ("Stay") is chosen, the pane stays usable on the
// old version and the restart is retried the next night.
export type RestartOutcome =
  | "restarted" | "did-not-exit" | "did-not-return" | "stuck-on-dialog" | "unknown-session";

// Conversation id from the exit banner, verified against the transcript. `"unverifiable"` =
// a banner is on screen, but it cannot be confirmed that it belongs to THIS exit →
// the caller must not guess. `null` = no banner, so there was nothing to restore.
// Exported for agentSwitch.ts (profile swap with best-effort --resume).
export async function bannerSessionId(
  deps: RestartDeps, container: string, pane: Pane, configDir: string | null,
): Promise<string | null | "unverifiable"> {
  const text = await paneText(deps, container, pane.target);
  if (text === null) return "unverifiable";
  const id = parseExitBannerId(text);
  if (id === null) return null;
  if (configDir === null) return "unverifiable";
  const r = await deps.exec(container, transcriptFreshCmd(configDir, id, TRANSCRIPT_FRESH_MIN), 15_000);
  if (r.code !== 0 || r.timedOut) return "unverifiable";
  // Empty `find` output = the transcript for that id was not being written now → the banner
  // is old, left on screen after a past restart.
  return r.stdout.trim() === "" ? "unverifiable" : id;
}

/** Pane restart plan — one protocol for the nightly upkeep, account switch
 *  (accountSwitch) and agent swap (agentSwitch). Defaults = exactly the behaviour of the
 *  original restartClaudePane; the protocol was tuned by three live incidents
 *  (C-u cleanup 18 Aug, resume dialog 2.1.234, timeouts), so it exists only ONCE. */
export interface PaneRestartPlan {
  /** Export into the pane shell before the launch command (`export …; <launch>`). */
  cmdPrefix?: string;
  /** Launch command from the (optional) conversation id. Default ccResumeCmd. */
  launch?: (id: string | null) => string;
  /** How to terminate the agent: "slash-exit" = `/exit` (claude only — writes the transcript,
   *  prints the exit banner, unregisters Remote Control), `{ kill }` = SIGTERM to the pid
   *  (codex/grok — they have no slash command for exiting). */
  exit?: "slash-exit" | { kill: number; comm: string };
  /** Detect the conversation id (argv + exit banner)? false = the target cannot `--resume`. */
  harvestId?: boolean;
  /** Unverifiable id: true (default) = leave the pane at the shell ("unknown-session" —
   *  the nightly upkeep must not guess), false = start clean (agent swap: the user
   *  explicitly asked for the restart and a clean start is safe — only
   *  `--continue` was dangerous, and it is never used here). */
  requireId?: boolean;
  /** Which process must live in the pane's subtree after start. Default "claude". */
  returnComm?: string;
  /** Agent pid, when the caller already knows it (saves one ps exec). */
  agentPid?: number;
  /** Account changes must preserve the exact current conversation. Unlike the
   *  upkeep fallback, neither absent banners nor stale argv permit a new chat. */
  exactClaudeAccount?: { sourceConfigDir: string; targetConfigDir: string };
}

// Only metadata leaves these probes. The boundary uses the container's own
// filesystem clock; the transcript must have been written by this exit, not
// merely sometime within upkeep's five-minute freshness window.
export const CLAUDE_RESUME_PREFLIGHT = `# CLAUDE_RESUME_PREFLIGHT
import json, os, sys, tempfile, time
from pathlib import Path
pid, source, target = sys.argv[1:]
env = dict(p.split(b"=", 1) for p in Path("/proc/" + pid + "/environ").read_bytes().split(b"\\0") if b"=" in p)
assert env.get(b"CLAUDE_CONFIG_DIR", b"").decode() == source
assert Path("/proc/" + pid + "/comm").read_text().strip() == "claude"
assert os.path.samefile(Path(source) / "projects", Path(target) / "projects")
credentials = Path(target) / ".credentials.json"
assert credentials.is_file() and credentials.stat().st_size > 0 and os.access(credentials, os.R_OK)
# Linux inode timestamps can lag time.time_ns() by a filesystem clock tick.
# Measure on the transcript filesystem, then cross a tick before /exit can run.
# Strictly newer transcript mtime rejects even unchanged files from that tick.
with tempfile.NamedTemporaryFile(prefix=".devd-cc-resume-", dir=Path(source) / "projects") as marker:
    marker.write(b"0")
    marker.flush()
    boundary = Path(marker.name).stat().st_mtime_ns
    deadline = time.monotonic() + 2
    while True:
        time.sleep(0.005)
        marker.seek(0)
        marker.write(b"1")
        marker.flush()
        if Path(marker.name).stat().st_mtime_ns > boundary:
            break
        assert time.monotonic() < deadline, "Transcript filesystem clock did not advance"
print(json.dumps({"boundaryNs": str(boundary)}))
`;

export const CLAUDE_RESUME_TRANSCRIPT = `# CLAUDE_RESUME_TRANSCRIPT
import os, sys
from pathlib import Path
source, target, conversation, boundary = sys.argv[1:]
source_root, target_root = Path(source) / "projects", Path(target) / "projects"
assert os.path.samefile(source_root, target_root)
matches = list(source_root.glob("*/" + conversation + ".jsonl"))
assert len(matches) == 1
transcript = matches[0]
destination = target_root / transcript.relative_to(source_root)
assert os.path.samefile(transcript, destination)
stat = transcript.stat()
assert stat.st_size > 0 and stat.st_mtime_ns > int(boundary)
assert os.access(destination, os.R_OK)
print("ok")
`;

function exactExitBannerId(before: string, after: string): string | null {
  if (before === after) return null;
  const pattern = `Resume this session with:\\s*\\n\\s*claude --resume (${UUID})(?:\\s|$)`;
  // Capture contains only the viewport: scrolling can discard an old copy of
  // the same banner as the new one arrives. Prefer the appended tail when the
  // end of the old viewport still anchors the start of the new viewport.
  const oldLines = before.trimEnd().split("\n"), newLines = after.trimEnd().split("\n");
  for (let overlap = Math.min(oldLines.length, newLines.length); overlap > 0; overlap--) {
    if (!oldLines.slice(-overlap).every((line, i) => line === newLines[i])) continue;
    const appended = [...newLines.slice(overlap).join("\n").matchAll(new RegExp(pattern, "g"))];
    return appended.at(-1)?.[1] ?? null;
  }
  const matches = [...after.matchAll(new RegExp(pattern, "g"))];
  const id = matches.at(-1)?.[1] ?? null;
  if (id === null) return null;
  const previous = [...before.matchAll(new RegExp(pattern, "g"))].filter(m => m[1] === id).length;
  return matches.filter(m => m[1] === id).length > previous ? id : null;
}

// Terminates the agent and runs the plan's launch command in the SAME pane (default: `cc
// --resume <id of that conversation>` — `cc` passes arguments through (image/cc:14) and
// re-registers with Remote Control on every start). `cmdPrefix` is EXPORTED into the pane
// shell (`export …; <launch>`), not just used as a prefix of one command —
// otherwise a bare restart from the nightly ccUpkeep would, in the next round, silently inherit
// the old value from the shell (exactly how the pane kept returning to the original account).
//
// The id is determined from three sources, in this order:
//   0. cc's own `sessions/<pid>.json` of the live claude (see CLAUDE_LIVE_SESSION) — current
//      even after `/resume`, read before `/exit`. With a transcript behind it, it wins; without
//      one the conversation is empty and a bare `cc` loses nothing. On 30 Oct 2026 a pane on a
//      35 MB conversation started without `--resume` showed no banner after `/exit`, so the
//      old "no banner = empty" rule started a NEW conversation and the next night resumed that,
//   1. the exit banner cc prints on exit, verified against the transcript — it is
//      CURRENT: it says what the pane was on RIGHT NOW,
//   2. the argv of the live claude (`--resume`/`--session-id`), read before `/exit`
//      — a safety net in case the banner cannot be verified. On its own it goes stale: after
//      `/clear` the pane runs on a NEW conversation, but argv still carries the original id,
//      which is why it comes second.
// When neither works and a banner is on screen, it returns (with requireId)
// "unknown-session" and the pane stays at the shell — see RestartOutcome.
//
// When the agent does not exit within the limit, the launch command is deliberately NOT SENT:
// the text would otherwise be typed into the middle of a running conversation.
export async function restartPane(
  deps: RestartDeps, container: string, pane: Pane, plan: PaneRestartPlan = {},
): Promise<RestartOutcome> {
  const harvest = plan.harvestId ?? true;
  const exitMode = plan.exit ?? "slash-exit";
  const returnComm = plan.returnComm ?? "claude";

  // While claude is alive, its argv and account profile can be read; after `/exit` not anymore.
  // Both /proc reads target the same pid and are independent — they run concurrently.
  const claudePid = !harvest ? null : plan.agentPid ?? await paneClaudePid(deps, container, pane);
  const [fromCmdline, configDir] = claudePid === null ? [null, null] : await Promise.all([
    deps.exec(container, ["cat", `/proc/${claudePid}/cmdline`], 10_000).then((r) => parseSessionIdFromCmdline(r.stdout)),
    paneConfigDir(deps, container, claudePid),
  ]);
  const fromSessionFile = claudePid === null || configDir === null || plan.exactClaudeAccount
    ? null : await liveSessionId(deps, container, claudePid, configDir);

  const exact = plan.exactClaudeAccount;
  let boundaryNs: string | null = null;
  let beforeExit: string | null = null;
  if (exact) {
    if (!harvest || returnComm !== "claude" || exitMode !== "slash-exit" || claudePid === null || configDir !== exact.sourceConfigDir)
      return "unknown-session";
    try {
      const preflight = await deps.exec(container, ["python3", "-c", CLAUDE_RESUME_PREFLIGHT, String(claudePid), exact.sourceConfigDir, exact.targetConfigDir], 15_000);
      if (preflight.code !== 0 || preflight.timedOut) return "unknown-session";
      const parsed = JSON.parse(preflight.stdout) as { boundaryNs?: unknown };
      if (typeof parsed.boundaryNs !== "string" || !/^\d+$/.test(parsed.boundaryNs)) return "unknown-session";
      boundaryNs = parsed.boundaryNs;
      beforeExit = await paneText(deps, container, pane.target);
      if (beforeExit === null || await paneClaudePid(deps, container, pane) !== claudePid) return "unknown-session";
    } catch { return "unknown-session"; }
  }

  if (exitMode === "slash-exit") {
    const exit = await deps.exec(container, ["tmux", "send-keys", "-t", pane.target, "/exit", "Enter"], 10_000);
    if (exit.code !== 0 || exit.timedOut) return "did-not-exit";   // keys did not arrive, no point waiting for the outcome

    const waited = await waitForExitOrDialog(deps, container, pane, 30_000);
    if (waited === "dialog") {
      // cc 2.1.260: the pane has unfinished background work (a running Bash tool, an agent) and
      // instead of exiting showed the dialog "Exit and stop tasks / Move to background and
      // exit / Stay". Neither the upkeep nor the account/agent switch may stop it or send it to the
      // background without the operator knowing — Esc ("Stay") is chosen. Nothing was typed into
      // the input field, so unlike the case below there is nothing to clean up with C-u.
      try { await deps.exec(container, ["tmux", "send-keys", "-t", pane.target, "Escape"], 10_000); } catch { /* best-effort */ }
      await waitForExitDialogGone(deps, container, pane.target, EXIT_DIALOG_GONE_WAIT_MS);
      console.error(`cc upkeep: panel ${pane.target} has background work in progress — exit dialog cancelled (Stay), staying on the old cc version`);
      return "did-not-exit";
    }
    if (waited === "timeout") {
      // cc refused to exit for another reason — typically the session manager home
      // screen, where `/exit` is not a command but just text typed into the input field.
      // It is cleaned up with C-u (kill line); Escape, which had been tried since 26 Jul, does
      // not touch cc's input field — verified live 18 Aug 2026, when one pane
      // accumulated five `/exit` in a row this way. The result is ignored: it does not hurt the
      // pane, and even without the cleanup it stays functional (just on the old version).
      try { await deps.exec(container, ["tmux", "send-keys", "-t", pane.target, "C-u"], 10_000); } catch { /* best-effort */ }
      return "did-not-exit";
    }
    // waited === "exited" → cc really ended, continue as before.
  } else {
    const kill = await deps.exec(container, ["kill", String(exitMode.kill)], 10_000);
    if (kill.code !== 0 || kill.timedOut) return "did-not-exit";
    if (!await waitForProcs(deps, container, pane.pid, [exitMode.comm], false, 15_000)) return "did-not-exit";
  }

  let id: string | null = null;
  if (exact) {
    try {
      const after = await paneText(deps, container, pane.target);
      id = after === null ? null : exactExitBannerId(beforeExit!, after);
      if (id === null) return "unknown-session";
      const transcript = await deps.exec(container, ["python3", "-c", CLAUDE_RESUME_TRANSCRIPT, exact.sourceConfigDir, exact.targetConfigDir, id, boundaryNs!], 15_000);
      if (transcript.code !== 0 || transcript.timedOut || transcript.stdout.trim() !== "ok") return "unknown-session";
    } catch { return "unknown-session"; }
  } else if (harvest) {
    // A session file without a transcript = an empty conversation → bare `cc` (id stays null).
    const written = fromSessionFile === null ? null : await transcriptExists(deps, container, configDir!, fromSessionFile);
    if (written !== null) {
      if (written) id = fromSessionFile;
    } else {
      const banner = await bannerSessionId(deps, container, pane, configDir);
      // The banner could not be verified → no guessing; only what we are sure of from argv
      // is used, otherwise (with requireId) the pane is left at the shell.
      if (banner === "unverifiable" && fromCmdline === null && (plan.requireId ?? true)) return "unknown-session";
      // No banner = cc had nothing to restore (empty conversation). `fromCmdline` is then
      // at most the same id, so it does no harm, and when absent a bare `cc` is launched.
      id = banner === "unverifiable" || banner === null ? fromCmdline : banner;
    }
  }

  const startCmd = `${plan.cmdPrefix ?? ""}${(plan.launch ?? ccResumeCmd)(id)}`;
  const cont = await deps.exec(container, ["tmux", "send-keys", "-t", pane.target, startCmd, "Enter"], 10_000);
  if (cont.code !== 0 || cont.timedOut) return "did-not-return";
  if (!await waitForProcs(deps, container, pane.pid, [returnComm], true, 60_000)) return "did-not-return";
  // A live `claude` process does not yet mean a usable pane — since 2.1.234 it can
  // stop on a prompt asking how to restore the session. This is checked wherever the id was
  // harvested at all (the restart "ends only with a usable pane", see tests) — only a deliberately
  // clean start without harvest (swap from another runtime) cannot trigger the dialog
  // and does not wait for the dialog window.
  if (returnComm === "claude" && (harvest || id !== null)) {
    if (!await answerResumeDialog(deps, container, pane)) return "stuck-on-dialog";
    if (exact) {
      try {
        const returnedPid = await paneClaudePid(deps, container, pane);
        if (returnedPid === null || returnedPid === claudePid) return "did-not-return";
        const [accountDir, argv] = await Promise.all([
          paneConfigDir(deps, container, returnedPid),
          deps.exec(container, ["cat", `/proc/${returnedPid}/cmdline`], 10_000),
        ]);
        if (accountDir !== exact.targetConfigDir || argv.code !== 0 || argv.timedOut || parseSessionIdFromCmdline(argv.stdout) !== id)
          return "unknown-session";
      } catch { return "unknown-session"; }
    }
    return "restarted";
  }
  return "restarted";
}

export async function restartClaudePane(
  deps: RestartDeps, container: string, pane: Pane, cmdPrefix = "",
): Promise<RestartOutcome> {
  return restartPane(deps, container, pane, { cmdPrefix });
}

export interface UpkeepResult {
  latest: string | null;
  built: boolean;
  updated: string[];    // sessions where the new version was installed
  restarted: string[];  // sessions where additionally at least one cc pane was restarted
  skipped: string[];    // sessions that were not idle
}

// The name is held by both setup.sh (build_image) and this job — both build the same keeper.
export const KEEPER_NAME = "devbox-image-keeper";

const NPM_TIMEOUT = 60_000;
const BUILD_TIMEOUT = 30 * 60_000;
const NPM_INSTALL_TIMEOUT = 5 * 60_000;

// `only` = list of session ids; without it all running ones are processed (nightly tick).
// A manual run from the dashboard narrows the run to one session with it — same rules,
// just a smaller set.
export async function runCcUpkeep(deps: UpkeepDeps, only?: string[]): Promise<UpkeepResult> {
  const res: UpkeepResult = { latest: null, built: false, updated: [], restarted: [], skipped: [] };

  // The host has no node/npm (verified live on the VPS: `which npm` empty, exit 127) — npm
  // exists only inside the image. `docker run --rm` with it works the same as for
  // `claude --version` a few lines below (the image ENTRYPOINT execs the arguments).
  const view = await deps.host(["docker", "run", "--rm", deps.image, "npm", "view", "@anthropic-ai/claude-code", "version"], NPM_TIMEOUT);
  const latest = view.code === 0 ? parseCcVersion(view.stdout) : null;
  if (!latest) return res;   // offline / npm down → quietly retry tomorrow
  res.latest = latest;

  // Image: build only when it is really older. Containers are handled independently —
  // they can lag behind even a fresh image (they were created earlier).
  const imgOut = await deps.host(["docker", "run", "--rm", deps.image, "claude", "--version"], NPM_TIMEOUT);
  const imageVer = imgOut.code === 0 ? parseCcVersion(imgOut.stdout) : null;
  if (imageVer === null || isNewer(latest, imageVer)) {
    const build = await deps.host(
      ["docker", "build", "--build-arg", `CC_VERSION=${latest}`, "-t", deps.image, `${deps.repoDir}/image`], BUILD_TIMEOUT);
    if (build.code !== 0) {
      deps.notify("devbox", `Image build with Claude Code ${latest} failed — cc stays on the old version`);
      logEvent(deps.db, null, "cc_upgrade_failed", { to: latest, stderr: build.stderr.slice(-500) });
      return res;   // the old image still works; containers are not touched
    }
    res.built = true;
    // The build moved the tag to the new image, and the keeper (see build_image in
    // infra/setup.sh) holds the old one — a fresh devbox:latest would, until the first
    // session is created, again be without a container, and prune (Coolify, CI job on the runner)
    // would delete it as an orphan: on 23 Aug and 26 Aug 2026 that broke session creation,
    // AI subs and cron. Best-effort — a keeper failure must not bring down the upkeep,
    // the image is built and working.
    await deps.host(["docker", "rm", "-f", KEEPER_NAME], NPM_TIMEOUT);
    const keeper = await deps.host(["docker", "run", "-d", "--name", KEEPER_NAME,
      "--restart", "unless-stopped", "--entrypoint", "sleep", deps.image, "infinity"], NPM_TIMEOUT);
    if (keeper.code !== 0 || keeper.timedOut) {
      console.error(`cc upkeep: keeper did not start after the build: ${keeper.stderr.trim().slice(0, 200)}`);
    }
  }

  for (const s of listSessions(deps.db).filter((x) => x.status === "running" && (!only || only.includes(x.id)))) {
    try {
      const cur = await deps.exec(s.container, ["claude", "--version"], 30_000);
      const have = cur.code === 0 ? parseCcVersion(cur.stdout) : null;
      let installed = false;

      // Install and restart are TWO independent conditions. The disk may have long been
      // up to date (upgraded by cc's auto-updater), and the panes still run old code.
      // Previously the restart hung on the install → such sessions were never restarted.
      if (have === null || isNewer(latest, have)) {
        if (!await isQuiet(deps, s)) {
          res.skipped.push(s.id);
          logEvent(deps.db, s.id, "cc_skipped", { reason: "busy", phase: "install", from: have, to: latest });
          continue;
        }
        const inst = await deps.exec(
          s.container, ["sudo", "npm", "i", "-g", `@anthropic-ai/claude-code@${latest}`], NPM_INSTALL_TIMEOUT);
        if (inst.code !== 0) {
          console.error(`cc upkeep: npm i failed in ${s.id}: ${inst.stderr.trim()}`);
          logEvent(deps.db, s.id, "cc_upgrade_failed", { to: latest, stderr: inst.stderr.trim().slice(-500) });
          continue;
        }

        // `exit 0` from npm is NOT proof that cc runs. The platform binary (`@anthropic-ai/
        // claude-code-linux-x64`) is an *optional* dependency, and when it cannot be downloaded,
        // npm silently skips it — while deleting the old working one. The package then keeps
        // `bin/claude.exe`, which is a shell stub reporting "claude native binary not
        // installed". Live on 20 Aug 2026: the main package 2.1.237 came out at 23:57 UTC, its
        // linux-x64 only at 02:25 — the job hit that window, broke nine containers and ran
        // a pane restart on them, so nine sessions with work in progress were left lying dead.
        // The truth is therefore `claude --version`, not the install exit code.
        const check = await deps.exec(s.container, ["claude", "--version"], 30_000);
        const now = check.code === 0 ? parseCcVersion(check.stdout) : null;
        if (now !== latest) {
          // Roll back to the version that worked there until now — without it the container
          // would stay without a usable cc until the next manual intervention. `have === null`
          // means cc did not run even before: there is nothing to return to.
          let rolledBack = false;
          if (have) {
            const back = await deps.exec(
              s.container, ["sudo", "npm", "i", "-g", `@anthropic-ai/claude-code@${have}`], NPM_INSTALL_TIMEOUT);
            const after = await deps.exec(s.container, ["claude", "--version"], 30_000);
            rolledBack = back.code === 0 && after.code === 0 && parseCcVersion(after.stdout) === have;
          }
          console.error(`cc upkeep: ${s.id} reports no version after installing ${latest} (${check.stderr.trim().slice(0, 120)})`);
          deps.notify("devbox", rolledBack
            ? `Claude Code ${latest} installed broken in ${s.id} — rolled back to ${have}`
            : `Claude Code ${latest} installed broken in ${s.id} and cc is not running there now`);
          logEvent(deps.db, s.id, "cc_upgrade_failed",
            { to: latest, from: have, reason: "verify-failed", got: now, rolledBack });
          continue;   // leave the panes alone: a restart would no longer start cc
        }

        installed = true;
        res.updated.push(s.id);
      }

      const list = await deps.exec(s.container, PANES_CMD, 15_000);
      const ps = await deps.exec(s.container, PS_TREE_CMD, 15_000);
      const age = await deps.exec(s.container, BIN_AGE_CMD, 15_000);
      const binAge = age.code === 0 ? Number.parseInt(age.stdout.trim(), 10) : Number.NaN;
      if (!Number.isInteger(binAge)) console.error(`cc upkeep: could not determine binary age in ${s.id}: ${age.stderr.trim()}`);
      const targets = list.code === 0 && ps.code === 0 && Number.isInteger(binAge)
        ? stalePanes(parsePanes(list.stdout), parseProcTree(ps.stdout), binAge)
        : [];
      let restarted = 0;
      let stuck = 0;
      const stuckTargets: { target: string; reason: RestartOutcome }[] = [];
      for (const p of targets) {
        // Probe right before EACH pane, not just once before the loop — with several
        // panes, restarting one takes ~90 s and the operator may come back and start
        // working in another pane before its turn comes. The install is done,
        // so even without a restart the new version kicks in on the next cc start.
        // Per pane, not for the whole session: restarting a neighbour spins up a new cc that
        // briefly burns above the threshold, and that must not cost the remaining panes their turn.
        if (!await isPaneQuiet(deps, s, p)) {
          if (!res.skipped.includes(s.id)) res.skipped.push(s.id);
          logEvent(deps.db, s.id, "cc_skipped", { reason: "busy", phase: "restart", pane: p.target });
          continue;   // do not touch this pane, keep trying the others
        }
        const outcome = await restartClaudePane(deps, s.container, p);
        if (outcome === "restarted") restarted++;
        else if (outcome === "did-not-exit") {
          // Harmless: the pane keeps running (just on the old version) and is retried tomorrow —
          // it does NOT count towards `stuck`, which is reserved for panes that really need
          // human attention (see cc_restart_failed below).
          logEvent(deps.db, s.id, "cc_skipped", { reason: "did-not-exit", pane: p.target });
        } else { stuck++; stuckTargets.push({ target: p.target, reason: outcome }); }
      }
      if (restarted > 0) res.restarted.push(s.id);
      // Silence when there was nothing to do (disk up to date and no stale pane).
      if (installed || restarted > 0 || stuck > 0)
        logEvent(deps.db, s.id, "cc_upgraded", { from: have, to: latest, installed, restarted, stuck });
      // `stuck` is otherwise indistinguishable from the benign "the operator came back, restart
      // deliberately skipped" — and it does not fix itself: the image is already up, so the
      // session is not checked again the next night. A separate event keeps it visible
      // (without notify, see above).
      // One event per reason, not one lump: "pane without a live cc" and "pane waiting
      // for a key" are each handled differently, and mixing them into one sentence voids the advice.
      for (const reason of ["did-not-return", "stuck-on-dialog", "unknown-session"] as const) {
        const targets = stuckTargets.filter((x) => x.reason === reason).map((x) => x.target);
        if (targets.length) logEvent(deps.db, s.id, "cc_restart_failed", { targets, reason });
      }
    } catch (e) {
      console.error(`cc upkeep: session ${s.id} failed:`, e);
    }
  }
  return res;
}

export interface CcSessionStatus {
  id: string; project: string; repo: string;
  version: string | null;     // version on disk in the container; null = not determined
  panes: number | null;       // panes with a live cc; null = not determined (could not read the pane or process list)
  stalePanes: number | null;  // of those, the ones running on an older binary; null = not determined
  busyPct: number | null;     // the busiest claude in % of a core; 0 = none running, null = not determined
}

export interface CcStatus {
  latest: string | null;
  image: string | null;
  sessions: CcSessionStatus[];
}

// Read-only scan for the dashboard — changes nothing. Containers and both host queries run
// in parallel and each fails independently: the dashboard must always get at least what
// could be determined. What was not determined is `null` — never a computed zero,
// which would look "OK" in the table.
export async function ccStatus(deps: UpkeepDeps): Promise<CcStatus> {
  const hostVersion = async (cmd: string[]): Promise<string | null> => {
    try {
      const r = await deps.host(cmd, NPM_TIMEOUT);
      return r.code === 0 && !r.timedOut ? parseCcVersion(r.stdout) : null;
    } catch { return null; }
  };
  const rows = listSessions(deps.db).filter((s) => s.status === "running");
  const [latest, image, sessions] = await Promise.all([
    hostVersion(["docker", "run", "--rm", deps.image, "npm", "view", "@anthropic-ai/claude-code", "version"]),
    hostVersion(["docker", "run", "--rm", deps.image, "claude", "--version"]),
    Promise.all(rows.map((s) => scanSession(deps, s))),
  ]);
  return { latest, image, sessions };
}

async function scanSession(deps: UpkeepDeps, s: SessionRow): Promise<CcSessionStatus> {
  const base = { id: s.id, project: s.project, repo: s.repo };
  const unknown: CcSessionStatus = { ...base, version: null, panes: null, stalePanes: null, busyPct: null };
  try {
    const [ver, panesOut, psOut, ageOut, busyOut] = await Promise.all([
      deps.exec(s.container, ["claude", "--version"], 30_000),
      deps.exec(s.container, PANES_CMD, 15_000),
      deps.exec(s.container, PS_TREE_CMD, 15_000),
      deps.exec(s.container, BIN_AGE_CMD, 15_000),
      deps.exec(s.container, ["sh", "-c", BUSY_CLAUDE], 15_000 + BUSY_SAMPLE_MS),
    ]);
    const good = (r: ExecResult) => r.code === 0 && !r.timedOut;
    // Panes can only be counted with the process table — the live cc is a descendant of the pane.
    // When either half is missing, it is "don't know", not zero.
    const procs = good(psOut) ? parseProcTree(psOut.stdout) : null;
    const withClaude = procs && good(panesOut)
      ? parsePanes(panesOut.stdout).filter((p) => hasClaudeUnder(p.pid, procs))
      : null;
    const binAge = good(ageOut) ? Number.parseInt(ageOut.stdout.trim(), 10) : Number.NaN;
    const samples = good(busyOut) ? parseBusySamples(busyOut.stdout) : null;
    const pcts = samples ? [...samples.values()] : [];
    return {
      ...base,
      version: good(ver) ? parseCcVersion(ver.stdout) : null,
      panes: withClaude ? withClaude.length : null,
      stalePanes: withClaude && procs && Number.isInteger(binAge) ? stalePanes(withClaude, procs, binAge).length : null,
      busyPct: samples === null ? null : (pcts.length ? Math.max(...pcts) : 0),
    };
  } catch {
    return unknown;
  }
}
