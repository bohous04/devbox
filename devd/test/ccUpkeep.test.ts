import { expect, test } from "bun:test";
import { dueForCheck, inWindow, isNewer, parseCcVersion } from "../src/ccUpkeep";

test("parseCcVersion reads the output of `claude --version` and `npm view`", () => {
  expect(parseCcVersion("2.1.202 (Claude Code)\n")).toBe("2.1.202");
  expect(parseCcVersion("2.1.220\n")).toBe("2.1.220");
  expect(parseCcVersion("")).toBeNull();
  expect(parseCcVersion("npm ERR! 404 Not found")).toBeNull();
});

test("isNewer compares numbers, not strings", () => {
  expect(isNewer("2.1.220", "2.1.202")).toBe(true);
  expect(isNewer("2.1.9", "2.1.10")).toBe(false);   // as strings "9" > "10"
  expect(isNewer("2.2.0", "2.1.999")).toBe(true);
  expect(isNewer("2.1.202", "2.1.202")).toBe(false);
  expect(isNewer("2.1.202", "2.1.220")).toBe(false); // image newer than npm → no-op
});

test("inWindow handles a window across midnight", () => {
  const at = (h: number) => new Date(2026, 6, 25, h, 30, 0);
  expect(inWindow(at(3), 3, 5)).toBe(true);
  expect(inWindow(at(4), 3, 5)).toBe(true);
  expect(inWindow(at(5), 3, 5)).toBe(false);   // the upper bound is exclusive
  expect(inWindow(at(2), 3, 5)).toBe(false);
  expect(inWindow(at(23), 22, 2)).toBe(true);  // across midnight
  expect(inWindow(at(1), 22, 2)).toBe(true);
  expect(inWindow(at(3), 22, 2)).toBe(false);
});

test("dueForCheck lets the run through once a day", () => {
  const now = 100 * 3600_000;
  expect(dueForCheck(null, now)).toBe(true);
  expect(dueForCheck(now - 21 * 3600_000, now)).toBe(true);
  expect(dueForCheck(now - 2 * 3600_000, now)).toBe(false);
});

import { isPaneQuiet, isQuiet, parseBusySamples, type ExecResult, type UpkeepDeps } from "../src/ccUpkeep";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (): ExecResult => ({ code: 1, stdout: "", stderr: "no such container", timedOut: false });

const session = (id: string) => ({
  id, folder: "apps", project: "apps", repo: id, container: `dev-${id}`, port_base: 40100,
  status: "running" as const, solo: 0 as const, created_at: 0, last_active_at: 0, important: 0 as const,
});

function deps(over: Partial<UpkeepDeps> = {}): UpkeepDeps {
  return {
    db: null as never,
    exec: async () => ok(),
    host: async () => ok(),
    turnInProgress: () => false,
    notify: () => {},
    sleep: async () => {},
    repoDir: "/opt/vps-dev-infra",
    image: "devbox:latest",
    ...over,
  };
}

test("isQuiet: no running turn and no busy claude → quiet", async () => {
  expect(await isQuiet(deps(), session("a"))).toBe(true);
});

test("isQuiet: a turn in progress → hands off, the probe does not even ask the container", async () => {
  let asked = 0;
  const d = deps({ turnInProgress: () => true, exec: async () => { asked++; return ok(); } });
  expect(await isQuiet(d, session("a"))).toBe(false);
  expect(asked).toBe(0);
});

// Measured live: idle cc 1–7 % of a core, working 50–65 %. The threshold is 25 %.
test("isQuiet: idle cc (TUI overhead) is still quiet", async () => {
  expect(await isQuiet(deps({ exec: async () => ok("64 7\n") }), session("a"))).toBe(true);
});

test("isQuiet: a working cc → hands off", async () => {
  expect(await isQuiet(deps({ exec: async () => ok("64 53\n") }), session("a"))).toBe(false);
});

test("isQuiet: an unreadable sample is treated as busy", async () => {
  expect(await isQuiet(deps({ exec: async () => ok("nesmysl\n") }), session("a"))).toBe(false);
});

test("parseBusySamples: empty = no claude, otherwise pid → percent", () => {
  expect(parseBusySamples("")?.size).toBe(0);
  expect(parseBusySamples("64 7\n72 53\n")).toEqual(new Map([[64, 7], [72, 53]]));
  expect(parseBusySamples("garbage\n")).toBeNull();
});

// A neighbor's restart pushes the new cc over the threshold — that must not block the other panes.
const TWO_PANES_PS = "   62    61 900 bash\n   64    62 300 claude\n   72    61 900 bash\n   74    72 30 claude\n";

test("isPaneQuiet: only the neighboring pane is busy → this one is quiet", async () => {
  const d = deps({ exec: async (_c, cmd) => (cmd[0] === "ps" ? ok(TWO_PANES_PS) : ok("64 5\n74 80\n")) });
  expect(await isPaneQuiet(d, session("a"), { target: "main:0.0", pid: 62 })).toBe(true);
  expect(await isPaneQuiet(d, session("a"), { target: "main-2:0.0", pid: 72 })).toBe(false);
});

test("isQuiet: an unreachable container is considered not quiet", async () => {
  expect(await isQuiet(deps({ exec: async () => fail() }), session("a"))).toBe(false);
});

import { CLAUDE_LIVE_SESSION, hasClaudeUnder, parsePanes, parseProcTree, restartClaudePane, stalePanes } from "../src/ccUpkeep";

test("parsePanes reads `session:window.pane<TAB>pid` and skips garbage", () => {
  const raw = "main:0.0\t62\nmain-2:0.0\t120\n\nbroken-line\nmain-3:0.0\tnotanumber\n";
  expect(parsePanes(raw)).toEqual([
    { target: "main:0.0", pid: 62 },
    { target: "main-2:0.0", pid: 120 },
  ]);
});

// The live shape on the VPS: the pane holds claude-launch.sh (bash) and claude is only its child —
// so we must not look at `pane_current_command`, which reports "bash".
// Sloupce: pid ppid etimes comm.
const LAUNCHER_PS = "   61     1 900 zsh\n   62    61 900 bash\n   64    62 300 claude\n  120     1 900 zsh\n";

test("hasClaudeUnder: the launcher shape (pane → bash → claude) is recognized", () => {
  expect(hasClaudeUnder(62, parseProcTree(LAUNCHER_PS))).toBe(true);
});

test("hasClaudeUnder: the direct shape (the pane itself is claude) is recognized", () => {
  expect(hasClaudeUnder(64, parseProcTree(LAUNCHER_PS))).toBe(true);
});

test("hasClaudeUnder: a pane with only a shell has no claude", () => {
  expect(hasClaudeUnder(120, parseProcTree(LAUNCHER_PS))).toBe(false);
});

test("hasClaudeUnder: a cyclic process table does not break the traversal", () => {
  const cyclic = parseProcTree("   10    11 900 bash\n   11    10 900 bash\n");
  expect(hasClaudeUnder(10, cyclic)).toBe(false);
});

// Agent switching (agentSwitch.ts) looks for ANY agent process in the pane's subtree
// (claude/codex/grok), not just claude — the names match the runtime from AGENTS_TABLE
// (the same source as the watchdog's AGENT_PROCS).
import { agentProcsUnder } from "../src/ccUpkeep";

test("agentProcsUnder: finds codex/grok just like claude", () => {
  const ps = "   61     1 900 zsh\n   62    61 900 bash\n   64    62 300 codex\n  120     1 900 zsh\n  121   120 50 grok\n";
  const procs = parseProcTree(ps);
  expect(agentProcsUnder(62, procs, ["claude", "codex", "grok"]).map((p) => p.comm)).toEqual(["codex"]);
  expect(agentProcsUnder(120, procs, ["claude", "codex", "grok"]).map((p) => p.comm)).toEqual(["grok"]);
  expect(agentProcsUnder(120, procs, ["claude"])).toEqual([]);
});

// `/proc/<pid>/environ` is a NUL-separated list of KEY=VALUE, not line-based like ps —
// accountSwitch.ts reads the pane's CLAUDE_CONFIG_DIR from it to tell whether the
// pane is already on the target account (and does not need a restart).
import { envVarFromProcEnviron } from "../src/ccUpkeep";

test("envVarFromProcEnviron: finds the value among NUL-separated pairs", () => {
  const raw = "PATH=/usr/bin\0CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/primary\0HOME=/home/dev\0";
  expect(envVarFromProcEnviron(raw, "CLAUDE_CONFIG_DIR")).toBe("/home/dev/.claude-accounts/primary");
});

test("envVarFromProcEnviron: a missing key returns null, so does empty input", () => {
  expect(envVarFromProcEnviron("PATH=/usr/bin\0HOME=/home/dev\0", "CLAUDE_CONFIG_DIR")).toBe(null);
  expect(envVarFromProcEnviron("", "CLAUDE_CONFIG_DIR")).toBe(null);
});

test("envVarFromProcEnviron: the value may itself contain '=' (e.g. a path with a query)", () => {
  const raw = "SOME_URL=https://x?a=1\0CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/backup\0";
  expect(envVarFromProcEnviron(raw, "SOME_URL")).toBe("https://x?a=1");
  expect(envVarFromProcEnviron(raw, "CLAUDE_CONFIG_DIR")).toBe("/home/dev/.claude-accounts/backup");
});

test("envVarFromProcEnviron: a key that is a suffix of another key must not be confused (prefix match)", () => {
  // "MY_CLAUDE_CONFIG_DIR" must not match a search for "CLAUDE_CONFIG_DIR".
  const raw = "MY_CLAUDE_CONFIG_DIR=/wrong\0";
  expect(envVarFromProcEnviron(raw, "CLAUDE_CONFIG_DIR")).toBe(null);
});

// The restart must not depend on whether this job just installed — the binary could have
// been replaced by cc's auto-updater. What decides is whether claude has been running longer than the binary is old.
test("stalePanes: claude older than the binary → the pane is stale", () => {
  const panes = parsePanes("main:0.0\t62\n");
  expect(stalePanes(panes, parseProcTree(LAUNCHER_PS), 100)).toEqual([{ target: "main:0.0", pid: 62 }]);
});

test("stalePanes: claude started only after the binary was replaced → the pane is current", () => {
  const panes = parsePanes("main:0.0\t62\n");
  expect(stalePanes(panes, parseProcTree(LAUNCHER_PS), 600)).toEqual([]);
});

test("stalePanes: a pane without claude is ignored", () => {
  const panes = parsePanes("main-2:0.0\t120\n");
  expect(stalePanes(panes, parseProcTree(LAUNCHER_PS), 100)).toEqual([]);
});

const PANE = { target: "main:0.0", pid: 62 };
const PS_WITH_CLAUDE = "   62    61 900 bash\n   64    62 300 claude\n";
const PS_WITHOUT_CLAUDE = "   62    61 900 zsh\n";

// Pane in PS_WITH_CLAUDE: root 62 (bash) → claude 64.
const CMDLINE = (id: string) => `claude\0--dangerously-skip-permissions\0--resume\0${id}\0`;
const ENVIRON = "CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/max20\0";

/** Container mock for a pane restart. `cmdline`/`pane`/`fresh` control where the id can be found. */
function restartEnv(over: { cmdline?: string; pane?: string; fresh?: string; session?: string; written?: string } = {}) {
  const sent: string[][] = [];
  let started = false;
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        sent.push(cmd);
        if (cmd[4] !== "/exit" && cmd[4] !== "C-u") started = true;
        return ok();
      }
      if (cmd[0] === "ps") return ok(started ? PS_WITH_CLAUDE : PS_WITHOUT_CLAUDE);
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/cmdline") return ok(over.cmdline ?? "");
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(ENVIRON);
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane") return ok(over.pane ?? "");
      if (cmd[0] === "python3" && cmd[2]?.startsWith("# CLAUDE_LIVE_SESSION"))
        return over.session === undefined ? { ...ok(), code: 1 } : ok(`${over.session}\n`);
      if (cmd[0] === "find" && !cmd.includes("-newermt")) return ok(over.written ?? "");
      if (cmd[0] === "find") return ok(over.fresh ?? "");
      return ok();
    },
  });
  return { d, sent, cmds: () => sent.map((c) => c[4]) };
}

// Probe for a live claude BEFORE `/exit` (PS_WITH_CLAUDE), so its argv can be read.
const restartDeps = (over: Parameters<typeof restartEnv>[0] = {}) => {
  const e = restartEnv(over);
  let first = true;
  const inner = e.d.exec;
  e.d.exec = async (c, cmd, t) => {
    if (cmd[0] === "ps" && first) { first = false; return ok(PS_WITH_CLAUDE); }
    return inner(c, cmd, t);
  };
  return e;
};

test("restartClaudePane: id from the live cc's argv (no banner) → `cc --resume <id>`, NEVER --continue", async () => {
  const { d, sent, cmds } = restartDeps({ cmdline: CMDLINE(SID) });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(sent[0]).toEqual(["tmux", "send-keys", "-t", "main:0.0", "/exit", "Enter"]);
  expect(sent[1]).toEqual(["tmux", "send-keys", "-t", "main:0.0", `cc --resume ${SID}`, "Enter"]);
  expect(cmds().some((c) => c.includes("--continue"))).toBe(false);
});

// A pane started the old way (bare `cc`) has no id in argv — it is taken from the exit banner and
// verified against the transcript that the banner belongs to THIS exit.
//
// The banner is also FIRST in the order of sources (see the /clear test below).
test("restartClaudePane: without an id in argv a fresh exit banner is used", async () => {
  const { d, cmds } = restartDeps({
    pane: `Resume this session with:\nclaude --resume ${SID}\n78c1814a78f1%`,
    fresh: `/home/dev/.claude/projects/-workspace/${SID}.jsonl\n`,
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(cmds()).toEqual(["/exit", `cc --resume ${SID}`]);
});

// The banner takes precedence over argv: after `/clear` the pane runs a NEW conversation, but argv
// still carries the id cc was once started with. Following argv would take the pane
// back by one conversation.
test("restartClaudePane: a fresh banner overrides a stale id in argv (after /clear)", async () => {
  const { d, cmds } = restartDeps({
    cmdline: CMDLINE(OTHER),
    pane: `Resume this session with:\nclaude --resume ${SID}\n78c1814a78f1%`,
    fresh: `/home/dev/.claude/projects/-workspace/${SID}.jsonl\n`,
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(cmds()).toEqual(["/exit", `cc --resume ${SID}`]);
});

// Safety net: the banner cannot be verified, but argv carries the id — the pane is not let fall
// into the shell just because `find` did not answer.
test("restartClaudePane: an unverifiable banner + id in argv → resumed from argv", async () => {
  const { d, cmds } = restartDeps({
    cmdline: CMDLINE(SID),
    pane: `Resume this session with:\nclaude --resume ${OTHER}\n78c1814a78f1% cc\n`,
    fresh: "",
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(cmds()).toEqual(["/exit", `cc --resume ${SID}`]);
});

// The core of the 08-21 regression: a banner was left on screen from the PREVIOUS restart (the transcript
// was not being written now). No guessing allowed — the pane stays at the shell, where the id is visible.
test("restartClaudePane: an old banner (transcript not fresh) → \"unknown-session\", nothing is started", async () => {
  const { d, cmds } = restartDeps({
    pane: `Resume this session with:\nclaude --resume ${SID}\n78c1814a78f1% cc --continue\n`,
    fresh: "",
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("unknown-session");
  expect(cmds()).toEqual(["/exit"]);
});

// No banner = cc had nothing to offer → the conversation is empty and a bare `cc` loses
// nothing. This is the only path through which a NEW conversation may be created.
test("restartClaudePane: without a banner a bare `cc` is started", async () => {
  const { d, cmds } = restartDeps({ pane: "78c1814a78f1%\n" });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(cmds()).toEqual(["/exit", "cc"]);
});

// 30 Oct 2026: a pane on a 35 MB conversation, started without `--resume`, printed no banner
// after `/exit` — the old "no banner = empty" rule started a NEW conversation. cc's own
// sessions/<pid>.json knew the id all along.
test("restartClaudePane: cc's live session file gives the id when there is no banner and no argv id", async () => {
  const { d, cmds } = restartDeps({ pane: "78c1814a78f1%\n", session: SID, written: `/x/${SID}.jsonl\n` });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(cmds()).toEqual(["/exit", `cc --resume ${SID}`]);
});

// After an in-app `/resume` argv still names the conversation cc was STARTED with; following it
// takes the pane back to that one (the next night after the incident above: argv held the
// empty conversation, the pane was on the real one again).
test("restartClaudePane: the live session file overrides a stale argv id (after /resume)", async () => {
  const { d, cmds } = restartDeps({ cmdline: CMDLINE(OTHER), session: SID, written: `/x/${SID}.jsonl\n` });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(cmds()).toEqual(["/exit", `cc --resume ${SID}`]);
});

test("restartClaudePane: a live session that was never written is empty → bare `cc`, not the stale argv id", async () => {
  const { d, cmds } = restartDeps({ cmdline: CMDLINE(OTHER), session: SID, written: "" });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(cmds()).toEqual(["/exit", "cc"]);
});

test("restartClaudePane: an unreadable session file falls back to banner and argv", async () => {
  const { d, cmds } = restartDeps({ cmdline: CMDLINE(SID), session: "not-a-uuid" });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(cmds()).toEqual(["/exit", `cc --resume ${SID}`]);
});

// /proc exists only on Linux (CI, the VPS); the probe runs inside Linux containers.
test.skipIf(process.platform !== "linux")("CLAUDE_LIVE_SESSION: reads the id only for the same process (pid + procStart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-live-"));
  mkdirSync(join(dir, "sessions"));
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[19];
  const run = () => Bun.spawnSync(["python3", "-c", CLAUDE_LIVE_SESSION, String(process.pid), dir]);
  writeFileSync(join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart: start, sessionId: SID }));
  expect(run().stdout.toString().trim()).toBe(SID);
  writeFileSync(join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart: "1", sessionId: SID }));
  expect(run().exitCode).not.toBe(0);
});

// `dev switch` (accountSwitch.ts) prepends a profile export — the conversation id does not
// change because `projects` is a symlink shared across account profiles too.
test("restartClaudePane: cmdPrefix is prepended to the launch command", async () => {
  const { d, cmds } = restartDeps({ cmdline: CMDLINE(SID) });
  expect(await restartClaudePane(d, "dev-a", PANE, "export CLAUDE_CONFIG_DIR=/x; ")).toBe("restarted");
  expect(cmds()[1]).toBe(`export CLAUDE_CONFIG_DIR=/x; cc --resume ${SID}`);
});

// Safety property: while claude is in the pane's subtree, the launch command must
// not be sent — otherwise it would be typed as a prompt into the live conversation. A live case
// from the VPS: the session manager's home screen, where `/exit` is just text typed into
// the input field — cc never exits. Classified as "did-not-exit" and cleaned up,
// not as a generic "stuck".
//
// Cleaned up with C-u (kill line), not Escape: that does not touch cc's input field. Verified
// live on 2026-08-18 on dev-games-claudeSolo-3 — after Escape it still showed
// "/compact /exit/exit/exit", after C-u the field was empty. Over five nights
// five `/exit`s piled up in a row in one pane that way.
test("restartClaudePane: cc still running → \"did-not-exit\", the launch command is NOT SENT, the line is cleaned with C-u", async () => {
  const sent: string[][] = [];
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { sent.push(cmd); return ok(); }
      if (cmd[0] === "ps") return ok(PS_WITH_CLAUDE);   // claude does not disappear from the subtree
      return ok();
    },
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("did-not-exit");
  expect(sent.map((c) => c[4])).toEqual(["/exit", "C-u"]);
});

// cc 2.1.260: a pane with background work in progress (a running Bash tool, an agent) does not exit after
// `/exit`, but shows a dialog asking what to do with that work. Neither the nightly upkeep nor
// an account/agent switch may stop that work for the user or send it to the background
// without their knowledge — Esc ("Stay") is chosen. A verbatim capture of the pane from live use.
import { exitDialogShown } from "../src/ccUpkeep";

const EXIT_DIALOG = `   ❯ 1. Exit and stop tasks
     2. Move to background and exit
     3. Stay
   Enter to confirm · Esc to cancel
`;

test("exitDialogShown: a live dialog (even with a transcript before it) is recognized", () => {
  const withTranscript = `● Starting a background task…\n● Done, waiting for review.\n${EXIT_DIALOG}`;
  expect(exitDialogShown(withTranscript)).toBe(true);
});

// Without the "Enter to confirm" footer it is not a live dialog, just (perhaps) its remnant
// left over after the pane was redrawn — nothing may be pressed into the pane blindly.
test("exitDialogShown: without the \"Enter to confirm\" footer it is not a live dialog", () => {
  const noFooter = EXIT_DIALOG.split("\n").slice(0, 3).join("\n");
  expect(exitDialogShown(noFooter)).toBe(false);
});

// The same caution as with resumeDialogState: quoting the word "Stay" in prose (e.g. in
// a conversation about this bug) must not look like a live dialog.
test("exitDialogShown: \"Stay\" mentioned only in prose does not mean a dialog", () => {
  const prose = "● We chose Stay (Esc) as the default behavior with work in progress.\n❯\n";
  expect(exitDialogShown(prose)).toBe(false);
});

test("restartClaudePane: cc 2.1.260 shows a dialog about background work in progress → Escape (Stay), \"did-not-exit\", no C-u and no waiting the full 30 s", async () => {
  const sent: string[][] = [];
  let sleeps = 0;
  const d = deps({
    sleep: async () => { sleeps++; },
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { sent.push(cmd); return ok(); }
      if (cmd[0] === "ps") return ok(PS_WITH_CLAUDE);   // background tasks → claude does not exit
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane") return ok(EXIT_DIALOG);
      return ok();
    },
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("did-not-exit");
  expect(sent.map((c) => c[4])).toEqual(["/exit", "Escape"]);
  expect(sleeps).toBeLessThan(30);   // the dialog is recognized immediately, no waiting for claude's full timeout
});

// Launcher shape: the pane reports "bash", but claude lives under it. Previously it waited for
// `pane_current_command !== "claude"`, which was satisfied immediately → the launch command went
// into the running conversation. Going through the process tree, this does not happen.
test("restartClaudePane: the launcher shape (pane=bash, claude child) is not considered an exited cc", async () => {
  const sent: string[][] = [];
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { sent.push(cmd); return ok(); }
      if (cmd[0] === "ps") return ok("   61     1 900 zsh\n   62    61 900 bash\n   64    62 300 claude\n");
      return ok();
    },
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("did-not-exit");
  expect(sent.map((c) => c[4])).toEqual(["/exit", "C-u"]);
});

test("restartClaudePane: `/exit` is not delivered (send-keys fails) → \"did-not-exit\" immediately, no waiting and no Escape", async () => {
  const sent: string[][] = [];
  let psCalls = 0;
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        sent.push(cmd);
        return { code: 1, stdout: "", stderr: "no such pane", timedOut: false };
      }
      if (cmd[0] === "ps") { psCalls++; return ok(PS_WITHOUT_CLAUDE); }
      return ok();
    },
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("did-not-exit");
  // Nothing was typed (send-keys failed), so there is nothing to clean up with Escape.
  expect(sent.length).toBe(1);   // the launch command was not even attempted
  expect(psCalls).toBe(1);       // only the claude probe before /exit, no waiting for its result
});

// The launch command is sent, but cc does not come back within the limit — the pane ends up at
// a bare shell without a live cc and needs a human's attention.
test("restartClaudePane: cc does not come back after launch → \"did-not-return\"", async () => {
  const sent: string[][] = [];
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { sent.push(cmd); return ok(); }
      if (cmd[0] === "ps") return ok(PS_WITHOUT_CLAUDE);   // claude does not come back even after --continue
      return ok();
    },
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("did-not-return");
  expect(sent.map((c) => c[4])).toEqual(["/exit", "cc"]);
});

test("restartClaudePane: sending the launch command fails → \"did-not-return\" immediately, no waiting for the timeout", async () => {
  const sent: string[][] = [];
  let psCalls = 0;
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        sent.push(cmd);
        if (cmd[4] === "/exit") return ok();
        return { code: 1, stdout: "", stderr: "no such pane", timedOut: false };
      }
      if (cmd[0] === "ps") { psCalls++; return ok(PS_WITHOUT_CLAUDE); }
      return ok();
    },
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("did-not-return");
  expect(psCalls).toBe(2);   // probe before /exit + waiting for the exit; not for the return after an undelivered launch
});

import { answerResumeDialog, resumeDialogState, type RestartDeps } from "../src/ccUpkeep";

// A verbatim capture of a pane from the VPS (2026-08-18, dev-websites-camps-site): cc 2.1.234
// asks after `cc --continue` on a large session how to resume it, and waits for an answer.
const RESUME_DIALOG = `  ※ recap: The goal was to get shop.example.com into the index.
  /remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01VckW8
────────────────────────────────────────────────────────────────────────────────
  This session is 3h 36m old and 121.7k tokens.
  Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.
  ❯ 1. Resume from summary (recommended)
    2. Resume full session as-is
    3. Don't ask me again
  Enter to confirm · Esc to cancel
`;

// A capture of the same pane after answering — conversation resumed, cursor in the input field.
const PROMPT = `  ✻ Brewed for 49s
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  Opus 5 [high]  |  121K
`;

// Dialog with the "❯" cursor on the n-th option (1..3).
const cursorAt = (n: number) =>
  RESUME_DIALOG.replace("  ❯ 1.", "    1.").replace(`    ${n}.`, `  ❯ ${n}.`);

test("resumeDialogState: cursor on 1 → one step down to \"Resume full session as-is\"", () => {
  expect(resumeDialogState(RESUME_DIALOG)).toEqual({ kind: "ready", steps: 1 });
});

test("resumeDialogState: cursor already on the full session → do not move", () => {
  expect(resumeDialogState(cursorAt(2))).toEqual({ kind: "ready", steps: 0 });
});

test("resumeDialogState: cursor below the target → a negative step means up", () => {
  expect(resumeDialogState(cursorAt(3))).toEqual({ kind: "ready", steps: -1 });
});

test("resumeDialogState: a regular prompt has no dialog", () => {
  expect(resumeDialogState(PROMPT)).toEqual({ kind: "absent" });
});

// That sentence also appears in the transcript — e.g. when we talk with the agent directly about this
// bug. Without the "Enter to confirm" footer it is not a live dialog: nothing may be pressed
// into the pane, nor may it be reported as stuck.
test("resumeDialogState: the same sentence only in conversation text is not a dialog", () => {
  const quoted = `● The job failed because "Resuming the full session will consume a substantial
  portion of your usage limits" is a new prompt in 2.1.234.
❯
`;
  expect(resumeDialogState(quoted)).toEqual({ kind: "absent" });
});

// A numbered list in the conversation above the dialog must not shift the option indexes.
test("resumeDialogState: a numbered list in the transcript does not throw off the indexes", () => {
  const withList = `● Remaining:
  1. finish the tests
  2. deploy
${RESUME_DIALOG}`;
  expect(resumeDialogState(withList)).toEqual({ kind: "ready", steps: 1 });
});

// Dialog recognized, but we do not understand the options (different wording, cropped pane) → press nothing:
// a blind Enter would hit "Resume from summary" and irreversibly compact the conversation.
test("resumeDialogState: a dialog without recognizable options → unparsed", () => {
  const garbled = `  This session is 3h 36m old and 121.7k tokens.
  Resuming the full session will consume a substantial portion of your usage limits.
  Enter to confirm · Esc to cancel
`;
  expect(resumeDialogState(garbled)).toEqual({ kind: "unparsed" });
});

// The pane responds to arrows: the cursor moves, after Enter the prompt is visible.
function livePane(): { d: RestartDeps; sent: string[] } {
  const sent: string[] = [];
  let answered = false;
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[1] === "send-keys") {
        const key = cmd[4]!;
        sent.push(key);
        if (key === "Enter") answered = true;
        return ok();
      }
      if (cmd[1] === "capture-pane") {
        if (answered) return ok(PROMPT);
        return ok(cursorAt(1 + sent.filter((k) => k === "Down").length));
      }
      return ok();
    },
  });
  return { d, sent };
}

test("answerResumeDialog: moves the cursor to the full session and confirms", async () => {
  const { d, sent } = livePane();
  expect(await answerResumeDialog(d, "dev-a", PANE)).toBe(true);
  expect(sent).toEqual(["Down", "Enter"]);
});

test("answerResumeDialog: the dialog does not appear → nothing is pressed and the pane is fine", async () => {
  const sent: string[] = [];
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[1] === "send-keys") { sent.push(cmd[4]!); return ok(); }
      if (cmd[1] === "capture-pane") return ok(PROMPT);
      return ok();
    },
  });
  expect(await answerResumeDialog(d, "dev-a", PANE)).toBe(true);
  expect(sent).toEqual([]);
});

// The core of the 08-18 incident: cc hung on the dialog, but the `claude` process was running, so
// the job reported success. When answering the dialog does not work, it must end with false.
test("answerResumeDialog: the cursor does not move → the pane is reported as stuck", async () => {
  const d = deps({
    exec: async (_c, cmd) => (cmd[1] === "capture-pane" ? ok(cursorAt(1)) : ok()),
  });
  expect(await answerResumeDialog(d, "dev-a", PANE)).toBe(false);
});

test("answerResumeDialog: an unintelligible dialog → do not press blindly, report stuck", async () => {
  const sent: string[] = [];
  const garbled = `  Resuming the full session will consume a substantial portion of your usage limits.
  Enter to confirm · Esc to cancel
`;
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[1] === "send-keys") { sent.push(cmd[4]!); return ok(); }
      if (cmd[1] === "capture-pane") return ok(garbled);
      return ok();
    },
  });
  expect(await answerResumeDialog(d, "dev-a", PANE)).toBe(false);
  expect(sent).toEqual([]);
});

// Enter is pressed, but the dialog does not go away → the pane is still not usable.
test("answerResumeDialog: the dialog does not go away after confirming → stuck", async () => {
  const d = deps({
    exec: async (_c, cmd) => (cmd[1] === "capture-pane" ? ok(cursorAt(2)) : ok()),
  });
  expect(await answerResumeDialog(d, "dev-a", PANE)).toBe(false);
});

// The whole path: the restart ends only with a usable pane, not with a mere "claude process is running".
test("restartClaudePane: after launching cc answers the resume dialog → \"restarted\"", async () => {
  const keys: string[] = [];
  let continued = false;
  let answered = false;
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[1] === "send-keys") {
        keys.push(cmd[4]!);
        if (cmd[4] === "cc") continued = true;
        if (cmd[4] === "Enter" && continued) answered = true;
        return ok();
      }
      if (cmd[0] === "ps") return ok(continued ? PS_WITH_CLAUDE : PS_WITHOUT_CLAUDE);
      if (cmd[1] === "capture-pane") {
        if (!continued) return ok(PROMPT);
        return ok(answered ? PROMPT : cursorAt(1 + keys.filter((k) => k === "Down").length));
      }
      return ok();
    },
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("restarted");
  expect(keys).toEqual(["/exit", "cc", "Down", "Enter"]);
});

test("restartClaudePane: cc stays hanging on the dialog → \"stuck-on-dialog\", not \"restarted\"", async () => {
  let continued = false;
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[1] === "send-keys") {
        if (cmd[4] === "cc") continued = true;
        return ok();
      }
      if (cmd[0] === "ps") return ok(continued ? PS_WITH_CLAUDE : PS_WITHOUT_CLAUDE);
      if (cmd[1] === "capture-pane") return ok(continued ? cursorAt(1) : PROMPT);
      return ok();
    },
  });
  expect(await restartClaudePane(d, "dev-a", PANE)).toBe("stuck-on-dialog");
});

// ── a pane restart resumes a SPECIFIC conversation ──────────────────────────────
// Regression from 2026-08-21: `cc --continue` means "the newest conversation in the current
// directory", but cwd is /workspace in ALL containers and `~/.claude/projects` is
// a symlink into a shared volume — so "newest" is global across the whole devbox.
// The nightly upkeep restarted six panes in a row and four of them ended up on the SAME foreign
// conversation (live: dev-websites-car-dealer and dev-websites-conference-web had bit-identical
// pane content). That is why the restart goes exclusively through `cc --resume <id>`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ccResumeCmd, parseExitBannerId, parseSessionIdFromCmdline, transcriptFreshCmd,
} from "../src/ccUpkeep";

const SID = "f633d4ad-0fdb-461d-81d0-3ef4fdc71191";
const OTHER = "7c0926b8-faa7-46f8-9685-9cda435f9d7f";

test("parseSessionIdFromCmdline: `--resume <id>` from a live process (NUL-separated argv)", () => {
  const raw = `claude\0--dangerously-skip-permissions\0--remote-control\0dev-apps-x\0--resume\0${SID}\0`;
  expect(parseSessionIdFromCmdline(raw)).toBe(SID);
});

test("parseSessionIdFromCmdline: `--session-id <id>` is accepted too", () => {
  expect(parseSessionIdFromCmdline(`claude\0--session-id\0${SID}\0`)).toBe(SID);
});

// A pane started the old way (`cc` without arguments, or `cc --continue`) carries no ID —
// the caller must reach for the exit banner, not for the "newest" conversation.
test("parseSessionIdFromCmdline: without an ID returns null", () => {
  expect(parseSessionIdFromCmdline("claude\0--dangerously-skip-permissions\0")).toBeNull();
  expect(parseSessionIdFromCmdline("claude\0--continue\0")).toBeNull();
  expect(parseSessionIdFromCmdline("")).toBeNull();
});

// A flag without a value (truncated argv) must not smuggle the neighboring argument in as an ID.
test("parseSessionIdFromCmdline: `--resume` without a UUID is not an ID", () => {
  expect(parseSessionIdFromCmdline("claude\0--resume\0--verbose\0")).toBeNull();
  expect(parseSessionIdFromCmdline("claude\0--resume\0")).toBeNull();
});

// The real pane content after `/exit`, captured on 2026-08-21 on dev-apps-claudeSolo-2:
// above the fresh banner lies an OLD one from the nightly restart. The LAST one counts — it
// was just printed by the cc we have now exited.
const PANE_AFTER_EXIT = [
  "Resume this session with:",
  `claude --resume ${SID}`,
  "78c1814a78f1% cc --continue",
  "Resume this session with:",
  `claude --resume ${OTHER}`,
  "78c1814a78f1%",
].join("\n");

test("parseExitBannerId: of several banners the last one counts", () => {
  expect(parseExitBannerId(PANE_AFTER_EXIT)).toBe(OTHER);
});

test("parseExitBannerId: no banner → null (an empty conversation has nothing to resume)", () => {
  expect(parseExitBannerId("78c1814a78f1%\n")).toBeNull();
  expect(parseExitBannerId("")).toBeNull();
  expect(parseExitBannerId("claude --resume nesmysl\n")).toBeNull();
});

test("ccResumeCmd: without an ID a bare `cc` is started, with an ID the specific conversation", () => {
  expect(ccResumeCmd(null)).toBe("cc");
  expect(ccResumeCmd(SID)).toBe(`cc --resume ${SID}`);
});

test("transcriptFreshCmd: looks for that ID's transcript and only a freshly written one", () => {
  // `-L` is not cosmetic: in a profile from the account pool `projects` is a SYMLINK into the shared
  // ~/.claude/projects and GNU find without -L does not descend into a symlinked starting point.
  expect(transcriptFreshCmd("/home/dev/.claude-accounts/max20", SID, 5)).toEqual([
    "find", "-L", "/home/dev/.claude-accounts/max20/projects", "-name", `${SID}.jsonl`,
    "-newermt", "-5 minutes", "-print", "-quit",
  ]);
});

// A real find, not just the argv shape: on 2026-09-04 the shape passed the test and yet every
// fresh session (without `--resume` in argv) on an account profile ended up at the shell as
// "unknown-session" — `find <profile>/projects` returned empty, because `projects`
// is a symlink in the profile (link-shared-profile) and find without -L does not open it. A relative
// `-newermt "-5 minutes"` is supported only by GNU findutils (in the image and on the CI runner); on a mac
// there is usually bfs/BSD find, there the test is skipped instead of failing falsely.
function gnuFind(): string | null {
  for (const bin of ["gfind", "find"]) {
    try {
      const r = Bun.spawnSync([bin, "--version"]);
      if (r.exitCode === 0 && r.stdout.toString().includes("GNU findutils")) return bin;
    } catch { /* no binary */ }
  }
  return null;
}
const GNU_FIND = gnuFind();

test.skipIf(GNU_FIND === null)("transcriptFreshCmd finds a fresh transcript even through the account profile's symlinked `projects`", () => {
  const root = mkdtempSync(join(tmpdir(), "upkeep-find-"));
  try {
    const shared = join(root, "claude", "projects", "-workspace");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, `${SID}.jsonl`), "{}\n");
    const profile = join(root, "max20");
    mkdirSync(profile);
    symlinkSync(join(root, "claude", "projects"), join(profile, "projects"));

    const [, ...args] = transcriptFreshCmd(profile, SID, 5);
    const r = Bun.spawnSync([GNU_FIND!, ...args]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(join(profile, "projects", "-workspace", `${SID}.jsonl`));

    // An old transcript (a banner left over from the previous restart) must keep giving empty.
    utimesSync(join(shared, `${SID}.jsonl`), new Date(2026, 0, 1), new Date(2026, 0, 1));
    expect(Bun.spawnSync([GNU_FIND!, ...args]).stdout.toString().trim()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
