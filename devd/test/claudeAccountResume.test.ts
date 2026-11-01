import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_RESUME_PREFLIGHT, CLAUDE_RESUME_TRANSCRIPT, restartPane, type ExecResult, type RestartDeps } from "../src/ccUpkeep";

const SID = "11111111-1111-1111-1111-111111111111";
const OLD = "22222222-2222-2222-2222-222222222222";
const source = "/home/dev/.claude-accounts/primary", target = "/home/dev/.claude-accounts/backup";
const pane = { target: "main:0.0", pid: 62 };
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const bad = (): ExecResult => ({ code: 1, stdout: "", stderr: "fixture failure", timedOut: false });
const env = (dir: string) => `CLAUDE_CONFIG_DIR=${dir}\0`;
const argv = (id: string) => `claude\0--resume\0${id}\0`;
const banner = (id: string) => `Resume this session with:\nclaude --resume ${id}\n$ `;

function fixture() {
  const state = { before: "Current conversation", after: banner(SID), oldArgv: argv(OLD), newArgv: argv(SID), newConfig: target, preflight: ok('{"boundaryNs":"1000"}'), transcript: ok("ok"), returnedPid: 65, exited: false, started: false, sendExitFails: false };
  const commands: string[][] = [];
  const d: RestartDeps = {
    sleep: async () => {},
    exec: async (_container, cmd) => {
      commands.push(cmd);
      if (cmd[0] === "ps") return ok(`62 61 900 zsh\n${state.started ? `${state.returnedPid} 62 1 claude\n` : state.exited ? "" : "64 62 300 claude\n"}`);
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(env(source));
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/cmdline") return ok(state.oldArgv);
      if (cmd[0] === "cat" && cmd[1] === "/proc/65/environ") return ok(env(state.newConfig));
      if (cmd[0] === "cat" && cmd[1] === "/proc/65/cmdline") return ok(state.newArgv);
      if (cmd[0] === "python3") return cmd[2] === CLAUDE_RESUME_PREFLIGHT ? state.preflight : state.transcript;
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane") return ok(state.started ? "Resumed conversation" : state.exited ? state.after : state.before);
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        if (cmd[4] === "/exit") { if (state.sendExitFails) return bad(); state.exited = true; }
        else if (cmd[4]?.includes("cc --resume")) state.started = true;
        return ok();
      }
      throw new Error(`Unexpected fixture command: ${JSON.stringify(cmd)}`);
    },
  };
  const run = () => restartPane(d, "fixture", pane, { agentPid: 64, cmdPrefix: `export CLAUDE_CONFIG_DIR=${target}; `, exactClaudeAccount: { sourceConfigDir: source, targetConfigDir: target } });
  return { state, commands, run, sends: () => commands.filter(c => c[0] === "tmux" && c[1] === "send-keys").map(c => c[4]) };
}

test("strict account switch resumes the fresh native exit ID, not stale argv after /clear", async () => {
  const h = fixture();
  expect(await h.run()).toBe("restarted");
  expect(h.sends()).toEqual(["/exit", `export CLAUDE_CONFIG_DIR=${target}; cc --resume ${SID}`]);
  expect(h.commands.find(c => c[2] === CLAUDE_RESUME_TRANSCRIPT)?.slice(3)).toEqual([source, target, SID, "1000"]);
  expect(h.commands.some(c => c[1] === "/proc/65/cmdline")).toBe(true);
});

test("strict account switch never launches bare cc when there is no native exit banner", async () => {
  for (const oldArgv of ["", argv(OLD)]) {
    const h = fixture(); h.state.oldArgv = oldArgv; h.state.after = "$ ";
    expect(await h.run()).toBe("unknown-session");
    expect(h.sends()).toEqual(["/exit"]);
  }
});

test("strict account switch rejects an unchanged or merely reprinted stale banner", async () => {
  for (const suffix of ["", "\n$ "]) {
    const h = fixture(); h.state.before = banner(OLD); h.state.after = banner(OLD) + suffix;
    expect(await h.run()).toBe("unknown-session");
    expect(h.sends()).toEqual(["/exit"]);
  }
});

test("strict account switch recognizes a new same-ID exit banner after viewport scroll", async () => {
  const h = fixture();
  h.state.before = banner(SID) + "\ncurrent TUI footer";
  h.state.after = "current TUI footer\n" + banner(SID);
  expect(await h.run()).toBe("restarted");
});

test("unavailable shared profile or invalid preflight blocks account switch before /exit", async () => {
  for (const result of [bad(), ok(""), ok('{"boundaryNs":123}'), { ...ok('{"boundaryNs":"1000"}'), timedOut: true }]) {
    const h = fixture(); h.state.preflight = result;
    expect(await h.run()).toBe("unknown-session");
    expect(h.sends()).toEqual([]);
  }
});

test("missing, stale or inaccessible exact transcript never falls back to argv or a new conversation", async () => {
  for (const result of [bad(), ok(""), { ...ok("ok"), timedOut: true }]) {
    const h = fixture(); h.state.transcript = result;
    expect(await h.run()).toBe("unknown-session");
    expect(h.sends()).toEqual(["/exit"]);
  }
});

test("returned Claude process must use the exact resumed ID and chosen account", async () => {
  for (const mismatch of ["id", "account", "bare"] as const) {
    const h = fixture();
    if (mismatch === "id") h.state.newArgv = argv(OLD);
    if (mismatch === "account") h.state.newConfig = source;
    if (mismatch === "bare") h.state.newArgv = "claude\0";
    expect(await h.run()).toBe("unknown-session");
  }
});

test("a stale old Claude PID is not accepted as a successful restart", async () => {
  const h = fixture(); h.state.returnedPid = 64;
  expect(await h.run()).toBe("did-not-return");
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const python = (script: string, ...args: string[]) => Bun.spawnSync(["python3", "-c", script, ...args]);

test("real filesystem preflight and transcript probes require one readable shared exact transcript written after exit boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-account-resume-")); dirs.push(root);
  const src = join(root, "source"), dst = join(root, "target"), proc = join(root, "proc");
  mkdirSync(join(src, "projects", "-workspace"), { recursive: true });
  mkdirSync(dst); symlinkSync(join(src, "projects"), join(dst, "projects"));
  writeFileSync(join(dst, ".credentials.json"), '{"fixture":true}');
  mkdirSync(join(proc, "64"), { recursive: true });
  writeFileSync(join(proc, "64", "environ"), env(src)); writeFileSync(join(proc, "64", "comm"), "claude\n");
  const transcript = join(src, "projects", "-workspace", SID + ".jsonl");
  writeFileSync(transcript, '{"sessionId":"' + SID + '"}\n');
  const preflight = python(CLAUDE_RESUME_PREFLIGHT.replaceAll('"/proc/"', JSON.stringify(proc + "/")), "64", src, dst);
  expect(preflight.exitCode).toBe(0);
  const { boundaryNs } = JSON.parse(preflight.stdout.toString());
  const check = () => python(CLAUDE_RESUME_TRANSCRIPT, src, dst, SID, boundaryNs);
  expect(readdirSync(join(src, "projects"))).toEqual(["-workspace"]);
  expect(check().exitCode).not.toBe(0); // An unchanged preflight-era transcript is stale, even in the same filesystem tick.
  writeFileSync(transcript, '{"sessionId":"' + SID + '","saved":true}\n');
  expect(check().exitCode).toBe(0);
  expect(check().stdout.toString().trim()).toBe("ok");
  const exactBoundary = python("import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[2])))", transcript, boundaryNs);
  expect(exactBoundary.exitCode).toBe(0);
  expect(check().exitCode).not.toBe(0); // Equality cannot prove a write after the boundary.
  utimesSync(transcript, 1, 1);
  expect(check().exitCode).not.toBe(0);
  writeFileSync(transcript, "");
  expect(check().exitCode).not.toBe(0);
  writeFileSync(transcript, "fixture\n");
  mkdirSync(join(src, "projects", "other")); writeFileSync(join(src, "projects", "other", SID + ".jsonl"), "duplicate\n");
  expect(check().exitCode).not.toBe(0);
  rmSync(join(src, "projects", "other"), { recursive: true });
  rmSync(join(dst, "projects")); mkdirSync(join(dst, "projects"));
  expect(check().exitCode).not.toBe(0);
  expect(python(CLAUDE_RESUME_PREFLIGHT.replaceAll('"/proc/"', JSON.stringify(proc + "/")), "64", src, dst).exitCode).not.toBe(0);
});
