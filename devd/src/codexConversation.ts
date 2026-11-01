import transferProgram from "./codexConversationTransfer.py" with { type: "text" };
import { agentProcsUnder, PANES_CMD, parsePanes, parseProcTree, PS_TREE_CMD, type Pane, type RestartDeps } from "./ccUpkeep";
import { AGENT_RUNTIMES } from "./agents";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validId = (id: unknown): id is string => typeof id === "string" && THREAD_ID.exec(id)?.[0] === id;
// Visible TUI states. A running turn swallows /quit and /status, and resuming a
// conversation with a paused goal opens a choice that would swallow later keys.
const TURN_RUNNING = /\besc to interrupt\b/i;
const GOAL_RUNNING = /\bPursuing goal\b/;
const GOAL_PROMPT = /\bResume paused goal\?/;
const COMPOSER_READY = /\? for shortcuts/;

// Capture only bytes emitted DURING this controlled graceful exit. Reading old
// scrollback or argv is unsafe: /new and the picker can change the current thread.
// Raw terminal content remains inside the container and is deleted after parsing.
export const CODEX_EXIT_CAPTURE = String.raw`# CODEX_EXIT_CAPTURE
import json, os, re, shlex, shutil, stat, subprocess, sys, tempfile, time
from pathlib import Path

def tmux(*args):
    return subprocess.run(["tmux", *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode()

def capture_dir(value):
    p = Path(value)
    if str(p.parent) != "/tmp" or not re.fullmatch(r"devd-codex-continuation-[a-zA-Z0-9_]+", p.name):
        raise ValueError("invalid capture")
    info = p.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("unsafe capture")
    return p

def main():
    action, target = sys.argv[1:3]
    if action == "begin":
        if tmux("display-message", "-p", "-t", target, "#{pane_pipe}").strip() != "0":
            raise ValueError("pane already has an output capture")
        path = Path(tempfile.mkdtemp(prefix="devd-codex-continuation-", dir="/tmp"))
        os.chmod(path, 0o700)
        try:
            tmux("pipe-pane", "-O", "-t", target, "umask 077; exec cat > " + shlex.quote(str(path / "exit")))
        except BaseException:
            shutil.rmtree(path)
            raise
        print(json.dumps({"capture": str(path)}))
        return
    path = capture_dir(sys.argv[3])
    try:
        if action != "peek-status":
            tmux("pipe-pane", "-t", target)
            # Closing the tmux pipe asks its reader to finish; let its final write land.
            time.sleep(0.1)
        if action == "cancel":
            print(json.dumps({"ok": True}))
            return
        capture = path / "exit"
        info = capture.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_size > 8 * 1024 * 1024:
            raise ValueError("unsafe capture output")
        text = capture.read_text(errors="replace")
        text = re.sub(r"\x1b\].*?(?:\x07|\x1b\\)", "", text, flags=re.S)
        # Cursor positioning/line clearing separates repainted terminal text;
        # stripping it to nothing would concatenate the old UI with the footer.
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[HfGJK]", "\n", text)
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        uuid = r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
        patterns = [r"\bTo continue this session, run:\s+codex resume " + uuid + r"(?:\s|$)",
                    r"(?:^|[\r\n])Reconnect:[^\r\n]*\bresume\s+" + uuid + r"(?:\s|$)",
                    r"(?:^|[\r\n])Session ID:\s*" + uuid + r"(?:\s|$)"]
        if action == "peek-status":
            patterns = [r"\bSession:\s*" + uuid + r"\b"]
        matches = [m for pattern in patterns for m in re.finditer(pattern, text)]
        thread = max(matches, key=lambda m: m.start()).group(1) if matches else None
        print(json.dumps({"threadId": thread}))
    finally:
        if action != "peek-status":
            shutil.rmtree(path)

try:
    main()
except Exception:
    print(json.dumps({"error": "Could not capture the exact current Codex conversation."}))
    sys.exit(1)
`;

export class CodexConversationError extends Error {}

export class CodexConversation {
  constructor(private d: RestartDeps) {}

  private async command(container: string, program: string, args: string[], timeout = 30_000): Promise<Record<string, unknown>> {
    const r = await this.d.exec(container, ["python3", "-c", program, ...args], timeout);
    if (r.code !== 0 || r.timedOut) throw new CodexConversationError("The exact Codex conversation could not be transferred safely.");
    try {
      const parsed = JSON.parse(r.stdout);
      if (!parsed || typeof parsed !== "object" || parsed.error) throw new Error("invalid helper result");
      return parsed;
    } catch { throw new CodexConversationError("The conversation helper returned no verified result."); }
  }

  private async requireProcess(container: string, pane: Pane, pid: number): Promise<void> {
    const [list, ps] = await Promise.all([this.d.exec(container, PANES_CMD, 10_000), this.d.exec(container, PS_TREE_CMD, 10_000)]);
    const processes = parseProcTree(ps.stdout);
    const nearest = agentProcsUnder(pane.pid, processes, AGENT_RUNTIMES)[0];
    if (list.code !== 0 || list.timedOut || ps.code !== 0 || ps.timedOut
      || !parsePanes(list.stdout).some(p => p.target === pane.target && p.pid === pane.pid)
      || processes.length !== ps.stdout.split("\n").filter(line => line.trim()).length
      || nearest?.pid !== pid || nearest?.comm !== "codex")
      throw new CodexConversationError("The Codex pane changed before the conversation command could be sent.");
  }

  private async screen(container: string, pane: Pane): Promise<string> {
    const r = await this.d.exec(container, ["tmux", "capture-pane", "-p", "-t", pane.target], 10_000);
    if (r.code !== 0 || r.timedOut) throw new CodexConversationError("Could not read the Codex pane.");
    return r.stdout;
  }

  /** Interrupt a running turn; true when a goal was being pursued (an exit or interrupt pauses it). */
  private async interrupt(container: string, pane: Pane, pid: number): Promise<boolean> {
    const before = await this.screen(container, pane);
    if (!TURN_RUNNING.test(before)) return GOAL_RUNNING.test(before);
    await this.requireProcess(container, pane, pid);
    const sent = await this.d.exec(container, ["tmux", "send-keys", "-t", pane.target, "Escape"], 10_000);
    if (sent.code !== 0 || sent.timedOut) throw new CodexConversationError("Codex did not receive the interrupt.");
    for (let step = 0; step < 30; step++) {
      await this.d.sleep(500);
      await this.requireProcess(container, pane, pid);
      if (!TURN_RUNNING.test(await this.screen(container, pane))) return GOAL_RUNNING.test(before);
    }
    throw new CodexConversationError("Codex did not stop its running turn; the conversation was left running.");
  }

  /** Answer the paused-goal choice a resumed conversation may open, before anything else is typed. */
  async settleGoalPrompt(container: string, pane: Pane, pid: number, resumeGoal: boolean): Promise<void> {
    for (let step = 0; step < 120; step++) {
      const text = await this.screen(container, pane);
      if (GOAL_PROMPT.test(text)) {
        await this.requireProcess(container, pane, pid);
        await this.d.exec(container, ["tmux", "send-keys", "-t", pane.target, resumeGoal ? "1" : "2"], 10_000);
        await this.d.sleep(500);
        if (GOAL_PROMPT.test(await this.screen(container, pane))) {
          await this.requireProcess(container, pane, pid);
          await this.d.exec(container, ["tmux", "send-keys", "-t", pane.target, "Enter"], 10_000);
        }
        return;
      }
      if (COMPOSER_READY.test(text)) return;
      await this.d.sleep(500);
    }
  }

  async stop(container: string, pane: Pane, expectedPid: number): Promise<{ threadId: string; resumeGoal: boolean }> {
    await this.requireProcess(container, pane, expectedPid);
    const resumeGoal = await this.interrupt(container, pane, expectedPid);
    // The exit banner is the exact proof, but some launches (the central-server
    // TUI) exit without printing it. Ask the live process first as a fallback.
    const known = await this.current(container, pane, expectedPid).catch(() => null);
    const capture = (await this.command(container, CODEX_EXIT_CAPTURE, ["begin", pane.target])).capture;
    if (typeof capture !== "string" || !/^\/tmp\/devd-codex-continuation-[a-zA-Z0-9_]+$/.test(capture))
      throw new CodexConversationError("Could not prepare an exact conversation capture.");
    let finished = false;
    try {
      await this.requireProcess(container, pane, expectedPid);
      const typed = await this.d.exec(container, ["tmux", "send-keys", "-t", pane.target, "C-u", "/quit"], 10_000);
      if (typed.code !== 0 || typed.timedOut) throw new CodexConversationError("Codex did not receive the graceful exit command.");
      // Codex treats a same-burst Enter as pasted text. Give its paste debounce
      // time to finish before submitting the slash command as a separate key.
      await this.d.sleep(500);
      await this.requireProcess(container, pane, expectedPid);
      const exit = await this.d.exec(container, ["tmux", "send-keys", "-t", pane.target, "Enter"], 10_000);
      if (exit.code !== 0 || exit.timedOut) throw new CodexConversationError("Codex did not receive the graceful exit command.");
      let gone = false;
      for (let step = 0; step < 30; step++) {
        await this.d.sleep(1000);
        const ps = await this.d.exec(container, PS_TREE_CMD, 10_000);
        if (ps.code !== 0 || ps.timedOut) continue;
        const processes = parseProcTree(ps.stdout);
        if (!processes.length || processes.length !== ps.stdout.split("\n").filter(line => line.trim()).length) continue;
        if (!agentProcsUnder(pane.pid, processes, ["codex"]).length) { gone = true; break; }
      }
      if (!gone) throw new CodexConversationError("Codex did not exit; its conversation was not transferred.");
      const receipt = await this.command(container, CODEX_EXIT_CAPTURE, ["finish", pane.target, capture]);
      finished = true;
      const exited = validId(receipt.threadId) ? receipt.threadId : null;
      if (exited && known && exited !== known) throw new CodexConversationError("The conversation changed while Codex was stopping. Codex remains stopped; no new conversation was started.");
      const threadId = exited ?? known;
      if (!threadId) throw new CodexConversationError("The exact current conversation could not be identified. Codex remains stopped; no new conversation was started.");
      return { threadId, resumeGoal };
    } finally {
      if (!finished) {
        try { await this.command(container, CODEX_EXIT_CAPTURE, ["cancel", pane.target, capture]); } catch { /* never hide the original safe-stop failure */ }
      }
    }
  }

  async current(container: string, pane: Pane, expectedPid: number): Promise<string> {
    const capture = (await this.command(container, CODEX_EXIT_CAPTURE, ["begin", pane.target])).capture;
    if (typeof capture !== "string" || !/^\/tmp\/devd-codex-continuation-[a-zA-Z0-9_]+$/.test(capture))
      throw new CodexConversationError("Could not prepare a current conversation capture.");
    try {
      await this.requireProcess(container, pane, expectedPid);
      const typed = await this.d.exec(container, ["tmux", "send-keys", "-t", pane.target, "C-u", "/status"], 10_000);
      if (typed.code !== 0 || typed.timedOut) throw new CodexConversationError("Could not request current conversation status.");
      await this.d.sleep(500);
      await this.requireProcess(container, pane, expectedPid);
      const enter = await this.d.exec(container, ["tmux", "send-keys", "-t", pane.target, "Enter"], 10_000);
      if (enter.code !== 0 || enter.timedOut) throw new CodexConversationError("Could not request current conversation status.");
      for (let attempt = 0; attempt < 10; attempt++) {
        await this.d.sleep(500);
        await this.requireProcess(container, pane, expectedPid);
        const result = await this.command(container, CODEX_EXIT_CAPTURE, ["peek-status", pane.target, capture]);
        if (validId(result.threadId)) return result.threadId;
      }
      throw new CodexConversationError("The pane did not confirm its current conversation.");
    } finally {
      try { await this.command(container, CODEX_EXIT_CAPTURE, ["cancel", pane.target, capture]); } catch { /* preserve the verification result */ }
    }
  }

  async transfer(container: string, sourceHome: string, targetHome: string, threadId: string, protectedThreadIds: string[] = []): Promise<{ cwd: string; empty?: boolean }> {
    if (!validId(threadId)) throw new CodexConversationError("A verified conversation ID is required.");
    const result = await this.command(container, transferProgram, ["transfer", "--source-home", sourceHome, "--target-home", targetHome, "--thread-id", threadId,
      ...protectedThreadIds.flatMap(id => ["--protected-thread-id", id]),
    ], 900_000); // Hundreds of subagents are archived one native request at a time.
    if (result.ok !== true || result.threadId !== threadId || typeof result.cwd !== "string"
      || result.cwd === "/" || !result.cwd.startsWith("/") || /[\x00-\x1f\x7f]/.test(result.cwd))
      throw new CodexConversationError("The exact conversation transfer was not confirmed.");
    return { cwd: result.cwd, ...(result.empty === true ? { empty: true } : {}) };
  }

  /** Central-server resumes fall back to default permissions; restore devbox full access. */
  async grantFullAccess(container: string, home: string, threadId: string): Promise<void> {
    if (!validId(threadId)) throw new CodexConversationError("Invalid conversation id.");
    const result = await this.command(container, transferProgram, ["grant-full-access", "--home", home, "--thread-id", threadId], 15_000);
    if (result.ok !== true || result.threadId !== threadId) throw new CodexConversationError("The conversation permissions could not be restored.");
  }

  async verify(container: string, home: string, threadId: string, pid: number, waitForStartup = false, allowUnpersisted = false): Promise<boolean> {
    if (!validId(threadId)) return false;
    for (let attempt = 0; attempt < (waitForStartup ? 20 : 1); attempt++) {
      try {
        const result = await this.command(container, transferProgram, ["verify", "--home", home, "--thread-id", threadId, "--writer-pid", String(pid), ...(allowUnpersisted ? ["--allow-unpersisted"] : [])], 10_000);
        if (result.ok === true && result.threadId === threadId) return true;
      } catch { /* process startup precedes acquiring the resumed thread writer */ }
      if (waitForStartup && attempt < 19) await this.d.sleep(1000);
    }
    return false;
  }
}
