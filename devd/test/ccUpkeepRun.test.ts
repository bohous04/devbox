import { expect, test } from "bun:test";
import { insertSession, listEvents, openDb } from "../src/db";
import { runCcUpkeep, type ExecResult, type UpkeepDeps } from "../src/ccUpkeep";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const err = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr, timedOut: false });

// `claude --version` reports the NEW version after a successful install — the job has verified this
// since 2026-08-20, so a mock that kept returning the old one after `npm i` would simulate a failure,
// not success. The hand-written exec runners in these tests therefore reach in here.
function ccVersion(initial: string) {
  let v = initial;
  return {
    read: () => ok(`${v} (Claude Code)\n`),
    install: (cmd: string[]) => { v = (cmd[4] ?? "").split("@").pop()!; return ok(""); },
  };
}

let nextPort = 40100;
const row = (id: string) => ({
  id, folder: "apps", project: "apps", repo: id, container: `dev-${id}`, port_base: nextPort++,
  status: "running" as const, solo: 0 as const, created_at: 0, last_active_at: 0, important: 0 as const,
});

// Host runner: `docker run … npm view` → latest (the host has no npm, it goes through the image),
// `docker run … claude --version` → version in the image, `docker build` → rebuild.
function hostRunner(latest: string, imageVer: string, buildOk = true) {
  const calls: string[][] = [];
  const run = async (cmd: string[]): Promise<ExecResult> => {
    calls.push(cmd);
    if (cmd[0] === "docker" && cmd[1] === "run" && cmd.includes("npm")) return ok(`${latest}\n`);
    if (cmd[0] === "docker" && cmd[1] === "run" && cmd.includes("claude")) return ok(`${imageVer} (Claude Code)\n`);
    if (cmd[0] === "docker" && cmd[1] === "build") return buildOk ? ok() : err("build failed");
    return ok();
  };
  return { calls, run };
}

// Panes are `target<TAB>pid`; a live cc is recognized from the process table (pane → bash →
// claude), not from `pane_current_command` — see the comment at PS_TREE_CMD in ccUpkeep.ts.
const PANE_A = "main:0.0\t62\n";
const PANE_A_B = "main:0.0\t62\nmain-2:0.0\t72\n";
// Process table (pid ppid etimes comm): for each pid that should have a live cc,
// adds a claude child. etimes 300 > BIN_AGE (100) → the pane is stale and gets a restart.
const BIN_AGE = "100\n";
function ps(...withClaude: number[]): string {
  const rows = ["   62    61 900 bash", "   72    61 900 bash"];
  for (const pid of withClaude) rows.push(`   ${pid + 1000}    ${pid} 300 claude`);
  return rows.join("\n") + "\n";
}
// Telling the two `sh -c` calls apart: the quiet probe vs. the binary age query.
const isBinAge = (cmd: string[]) => cmd[0] === "sh" && (cmd[2] ?? "").includes("stat -c");

// Exec runner: version in the container, quiet, panes, npm i, tmux.
// `npm i -g` bumps `versions[container]` — an install after which `claude --version`
// still reports the old version is exactly the failure the job must catch (see
// `installBroken`, where the binary does not run at all after the install).
function containerRunner(
  versions: Record<string, string>, panes: Record<string, string> = {},
  opts: { installBroken?: boolean } = {},
) {
  const calls: { container: string; cmd: string[] }[] = [];
  const exited = new Set<string>();   // after `/exit` the pane's subtree has no claude, after launching cc it has one again
  // After a restart the pane starts `cc` (without an id, when the mock has nowhere to take it from) or
  // `cc --resume <id>`; `dev switch` also prepends a profile export to it.
  const isStart = (keys: string) => /(^|;\s*)cc(\s|$)/.test(keys);
  const broken = new Set<string>();   // containers where the install left a dummy binary
  const exec = async (container: string, cmd: string[]): Promise<ExecResult> => {
    calls.push({ container, cmd });
    if (isBinAge(cmd)) return ok(BIN_AGE);
    if (cmd[0] === "claude") {
      // The dummy `bin/claude.exe` writes to stderr and exits with one — no version.
      if (broken.has(container)) return err("Error: claude native binary not installed.");
      return ok(`${versions[container]} (Claude Code)\n`);
    }
    if (cmd[0] === "sh") return ok("");                       // quiet: no busy claude
    if (cmd[0] === "sudo") {                                  // npm i -g @anthropic-ai/claude-code@<version>
      const want = (cmd[4] ?? "").split("@").pop()!;
      if (opts.installBroken && !broken.has(container)) broken.add(container);
      else { broken.delete(container); versions[container] = want; }
      return ok();
    }
    if (cmd[0] === "ps") return ok(exited.has(container) ? ps() : ps(62, 72));
    if (cmd[1] === "list-panes") return ok(panes[container] ?? "");
    if (cmd[1] === "send-keys") {
      if (cmd[4] === "/exit") exited.add(container);
      if (isStart(cmd[4]!)) exited.delete(container);
      return ok();
    }
    return ok();
  };
  return { calls, exec };
}

function deps(over: Partial<UpkeepDeps>): UpkeepDeps {
  return {
    db: openDb(":memory:"), exec: async () => ok(), host: async () => ok(),
    turnInProgress: () => false, notify: () => {}, sleep: async () => {},
    repoDir: "/opt/vps-dev-infra", image: "devbox:latest", ...over,
  };
}

test("new version: rebuilds the image with --build-arg and updates a quiet container", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.202");
  const cont = containerRunner({ "dev-a": "2.1.202" }, { "dev-a": PANE_A });
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec }));

  expect(res.latest).toBe("2.1.220");
  expect(res.built).toBe(true);
  // Pin: the version is determined via the image (`docker run`), not with a bare `npm` on the host —
  // the host has no npm installed, see the comment at the call in ccUpkeep.ts.
  const versionCall = host.calls.find((c) => c.includes("npm"));
  expect(versionCall).toEqual(["docker", "run", "--rm", "devbox:latest", "npm", "view", "@anthropic-ai/claude-code", "version"]);
  const buildCall = host.calls.find((c) => c[0] === "docker" && c[1] === "build");
  expect(buildCall).toEqual(["docker", "build", "--build-arg", "CC_VERSION=2.1.220", "-t", "devbox:latest", "/opt/vps-dev-infra/image"]);
  expect(cont.calls.some((c) => c.cmd.join(" ") === "sudo npm i -g @anthropic-ai/claude-code@2.1.220")).toBe(true);
  expect(res.updated).toEqual(["a"]);
  expect(res.restarted).toEqual(["a"]);
  expect(listEvents(db, { type: "cc_upgraded" }).length).toBe(1);
});

test("after a successful build the keeper switches to the new image", async () => {
  const db = openDb(":memory:");
  const host = hostRunner("2.1.220", "2.1.202");
  const res = await runCcUpkeep(deps({ db, host: host.run }));

  expect(res.built).toBe(true);
  const build = host.calls.findIndex((c) => c[0] === "docker" && c[1] === "build");
  const rm = host.calls.findIndex((c) => c[0] === "docker" && c[1] === "rm" && c.includes("devbox-image-keeper"));
  const run = host.calls.findIndex((c) => c[1] === "run" && c.includes("devbox-image-keeper"));
  // Order: build first (the tag already points to the new image), then the keeper swap —
  // otherwise between rm and run there would be no container from the current image.
  expect(build).toBeGreaterThanOrEqual(0);
  expect(rm).toBeGreaterThan(build);
  expect(run).toBeGreaterThan(rm);
  expect(host.calls[run]).toEqual(["docker", "run", "-d", "--name", "devbox-image-keeper",
    "--restart", "unless-stopped", "--entrypoint", "sleep", "devbox:latest", "infinity"]);
});

test("without a build and after a failed build the keeper is left alone", async () => {
  const untouched = async (host: ReturnType<typeof hostRunner>) => {
    expect(host.calls.some((c) => c.includes("devbox-image-keeper"))).toBe(false);
  };
  const fresh = hostRunner("2.1.220", "2.1.220");
  await runCcUpkeep(deps({ db: openDb(":memory:"), host: fresh.run }));
  await untouched(fresh);

  const failed = hostRunner("2.1.220", "2.1.202", false);
  await runCcUpkeep(deps({ db: openDb(":memory:"), host: failed.run }));
  await untouched(failed);
});

test("the image is current but the container lags behind → build is skipped, the container is updated", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.220");
  const cont = containerRunner({ "dev-a": "2.1.202" }, { "dev-a": "main:0.0\t99\n" });
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec }));

  expect(res.built).toBe(false);
  expect(host.calls.some((c) => c[1] === "build")).toBe(false);
  expect(res.updated).toEqual(["a"]);
  expect(res.restarted).toEqual([]);   // no claude in the pane's subtree → nothing to restart
});

test("a non-quiet session is skipped and nothing is started in it", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("busy"));
  const host = hostRunner("2.1.220", "2.1.202");
  const cont = containerRunner({ "dev-busy": "2.1.202" }, { "dev-busy": PANE_A });
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec, turnInProgress: () => true }));

  expect(res.updated).toEqual([]);
  expect(res.skipped).toEqual(["busy"]);
  expect(cont.calls.some((c) => c.cmd[0] === "sudo")).toBe(false);
});

test("the second quiet probe fails → the install stays, the restart is cancelled, no tmux intervention", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.202");
  const calls: { container: string; cmd: string[] }[] = [];
  const cc = ccVersion("2.1.202");
  let probeCalls = 0;
  // sh -c (busy-probe) is quiet the first time (before npm i) and busy the second time (right before the restart) —
  // the operator came back in the meantime.
  const exec = async (container: string, cmd: string[]): Promise<ExecResult> => {
    calls.push({ container, cmd });
    if (isBinAge(cmd)) return ok(BIN_AGE);
    if (cmd[0] === "claude") return cc.read();
    // 1st sample = the probe before the install (quiet), the next = per-pane probe (claude 1062 is grinding)
    if (cmd[0] === "sh") { probeCalls++; return probeCalls === 1 ? ok("1062 3\n") : ok("1062 60\n"); }
    if (cmd[0] === "sudo") return cc.install(cmd);                     // npm i -g
    if (cmd[0] === "ps") return ok(ps(62));
    if (cmd[1] === "list-panes") return ok(PANE_A);
    return ok();
  };
  const res = await runCcUpkeep(deps({ db, host: host.run, exec }));

  expect(res.updated).toEqual(["a"]);          // npm i ran
  expect(res.skipped).toEqual(["a"]);           // the restart was cancelled
  expect(res.restarted).toEqual([]);
  expect(calls.some((c) => c.cmd[1] === "send-keys")).toBe(false);   // no tmux intervention in the pane
  const events = listEvents(db, { type: "cc_upgraded" });
  expect(events.length).toBe(1);
  expect(JSON.parse(events[0]!.data!).restarted).toBe(0);
});

test("multiple panes: the operator comes back between restarts → the next pane is not touched, the session ends in skipped", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.202");
  const calls: { container: string; cmd: string[] }[] = [];
  const cc = ccVersion("2.1.202");
  let probeCalls = 0;
  const restartedTargets = new Set<string>();
  const exitedPids = new Set<number>([62, 72]);   // both panes have a live cc at the start
  // sh -c (busy-probe): quiet before npm i and before the first pane, busy before the second —
  // the operator managed to get back into main-2 while main was restarting (~90 s per pane).
  const exec = async (container: string, cmd: string[]): Promise<ExecResult> => {
    calls.push({ container, cmd });
    if (isBinAge(cmd)) return ok(BIN_AGE);
    if (cmd[0] === "claude") return cc.read();
    // Per pane: the first pane's claude (1062) is quiet, the second's (1072) is grinding —
    // the operator came back into main-2 while main was restarting.
    if (cmd[0] === "sh") { probeCalls++; return probeCalls === 1 ? ok("1062 4\n1072 5\n") : ok("1062 4\n1072 80\n"); }
    if (cmd[0] === "sudo") return cc.install(cmd);
    if (cmd[1] === "list-panes") return ok(PANE_A_B);
    if (cmd[1] === "send-keys") {
      if (cmd[4] === "/exit") exitedPids.delete(62);          // pane main:0.0 → cc exited
      if (/(^|;\s*)cc(\s|$)/.test(cmd[4]!)) exitedPids.add(62);   // …and came back up
      restartedTargets.add(cmd[3]!);
      return ok();
    }
    if (cmd[0] === "ps") return ok(ps(...exitedPids));
    return ok();
  };
  const res = await runCcUpkeep(deps({ db, host: host.run, exec }));

  expect(res.updated).toEqual(["a"]);
  expect(res.restarted).toEqual(["a"]);   // main:0.0 managed to restart
  expect(res.skipped).toEqual(["a"]);     // main-2:0.0 skipped, not the whole loop cut short
  const sentToSecond = calls.filter((c) => c.cmd[1] === "send-keys" && c.cmd[3] === "main-2:0.0");
  expect(sentToSecond.length).toBe(0);    // main-2:0.0 was not touched at all
  const events = listEvents(db, { type: "cc_upgraded" });
  expect(JSON.parse(events[0]!.data!).restarted).toBe(1);
  expect(JSON.parse(events[0]!.data!).stuck).toBe(0);
});

test("send-keys for launching cc fails → the pane stays stuck, events record it without a notification", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.202");
  const notes: string[] = [];
  let exited = false;
  const cc = ccVersion("2.1.202");
  const exec = async (_container: string, cmd: string[]): Promise<ExecResult> => {
    if (isBinAge(cmd)) return ok(BIN_AGE);
    if (cmd[0] === "claude") return cc.read();
    if (cmd[0] === "sh") return ok("");
    if (cmd[0] === "sudo") return cc.install(cmd);
    if (cmd[1] === "list-panes") return ok(PANE_A);
    if (cmd[1] === "send-keys") { if (cmd[4] === "/exit") exited = true; return cmd[4] === "/exit" ? ok() : err("no such pane"); }
    if (cmd[0] === "ps") return ok(exited ? ps() : ps(62));   // after /exit the subtree has no claude
    return ok();
  };
  const res = await runCcUpkeep(deps({ db, host: host.run, exec, notify: (_t, m) => { notes.push(m); } }));

  expect(res.updated).toEqual(["a"]);
  expect(res.restarted).toEqual([]);
  expect(notes).toEqual([]);   // only a build failure is notified, not a stuck restart
  const upgraded = listEvents(db, { type: "cc_upgraded" });
  expect(upgraded.length).toBe(1);
  expect(JSON.parse(upgraded[0]!.data!).restarted).toBe(0);
  expect(JSON.parse(upgraded[0]!.data!).stuck).toBe(1);
  const failed = listEvents(db, { type: "cc_restart_failed" });
  expect(failed.length).toBe(1);
  expect(JSON.parse(failed[0]!.data!)).toEqual({ targets: ["main:0.0"], reason: "did-not-return" });
});

// A live case from the VPS: a pane on the session manager's home screen, where `/exit` is
// just text typed into the input field — cc never exits. Unlike above (where cc
// exited and did not come back) this is harmless: the pane keeps working, just on the old version.
// It must NOT count toward `stuck` nor trigger cc_restart_failed — that is reserved for
// panes that really need a human's attention.
test("cc refuses to exit → cc_skipped { reason: \"did-not-exit\" }, stuck stays 0, no cc_restart_failed", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.202");
  const notes: string[] = [];
  const sent: string[][] = [];
  const cc = ccVersion("2.1.202");
  const exec = async (_container: string, cmd: string[]): Promise<ExecResult> => {
    if (isBinAge(cmd)) return ok(BIN_AGE);
    if (cmd[0] === "claude") return cc.read();
    if (cmd[0] === "sh") return ok("");
    if (cmd[0] === "sudo") return cc.install(cmd);
    if (cmd[1] === "list-panes") return ok(PANE_A);
    if (cmd[1] === "send-keys") { sent.push(cmd); return ok(); }
    if (cmd[0] === "ps") return ok(ps(62));   // claude never disappears from the pane's subtree (cc refuses to exit)
    return ok();
  };
  const res = await runCcUpkeep(deps({ db, host: host.run, exec, notify: (_t, m) => { notes.push(m); } }));

  expect(res.updated).toEqual(["a"]);
  expect(res.restarted).toEqual([]);
  expect(res.skipped).toEqual([]);   // this is not a busy-skip, see cc_skipped { reason: "did-not-exit" } below
  expect(notes).toEqual([]);
  expect(sent.map((c) => c[4])).toEqual(["/exit", "C-u"]);   // the launch command is NOT SENT, the line is cleaned up
  const upgraded = listEvents(db, { type: "cc_upgraded" });
  expect(upgraded.length).toBe(1);
  expect(JSON.parse(upgraded[0]!.data!)).toMatchObject({ restarted: 0, stuck: 0 });
  const skipped = listEvents(db, { type: "cc_skipped" });
  expect(skipped.length).toBe(1);
  expect(JSON.parse(skipped[0]!.data!)).toEqual({ reason: "did-not-exit", pane: "main:0.0" });
  expect(listEvents(db, { type: "cc_restart_failed" }).length).toBe(0);
});

test("a build failure → a notification and no intervention in containers", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.202", false);
  const cont = containerRunner({ "dev-a": "2.1.202" });
  const notes: string[] = [];
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec, notify: (_t, m) => { notes.push(m); } }));

  expect(res.built).toBe(false);
  expect(res.updated).toEqual([]);
  expect(notes.length).toBe(1);
  expect(notes[0]).toContain("2.1.220");
  expect(cont.calls.length).toBe(0);
});

test("npm view fails → a silent no-op, nothing is built", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const calls: string[][] = [];
  const notes: string[] = [];
  const res = await runCcUpkeep(deps({
    db, exec: async () => ok(),
    host: async (cmd) => { calls.push(cmd); return cmd.includes("npm") ? err("offline") : ok(); },
    notify: (_t, m) => { notes.push(m); },
  }));

  expect(res.latest).toBeNull();
  expect(res.built).toBe(false);
  expect(calls.some((c) => c[1] === "build")).toBe(false);
  expect(notes).toEqual([]);
});

test("one container failing does not cancel the pass over the others", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("bad"));
  insertSession(db, row("good"));
  const host = hostRunner("2.1.220", "2.1.220");
  const cc = ccVersion("2.1.202");
  const exec = async (container: string, cmd: string[]): Promise<ExecResult> => {
    if (container === "dev-bad") throw new Error("container unreachable");
    if (isBinAge(cmd)) return ok(BIN_AGE);
    if (cmd[0] === "claude") return cc.read();
    if (cmd[0] === "sudo") return cc.install(cmd);
    if (cmd[1] === "list-panes") return ok("");
    return ok("");
  };
  const origError = console.error;
  console.error = () => {};
  try {
    const res = await runCcUpkeep(deps({ db, host: host.run, exec }));
    expect(res.updated).toEqual(["good"]);
  } finally { console.error = origError; }
});

test("stopped sessions are ignored", async () => {
  const db = openDb(":memory:");
  insertSession(db, { ...row("stopped"), status: "stopped" as const });
  const host = hostRunner("2.1.220", "2.1.220");
  const cont = containerRunner({ "dev-stopped": "2.1.202" });
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec }));
  expect(res.updated).toEqual([]);
  expect(cont.calls.length).toBe(0);
});

// A live case from the VPS (portal): cc's auto-updater bumped the binary, so the disk is
// current — but the panes keep running old code. No install needed, a restart is.
test("disk current, pane runs old code → no install, but a restart", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.220");
  const cont = containerRunner({ "dev-a": "2.1.220" }, { "dev-a": PANE_A });
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec }));

  expect(cont.calls.some((c) => c.cmd[0] === "sudo")).toBe(false);   // no install
  expect(res.updated).toEqual([]);
  expect(res.restarted).toEqual(["a"]);                              // …and still a restart
  const ev = listEvents(db, { type: "cc_upgraded" });
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0]!.data!)).toMatchObject({ installed: false, restarted: 1, stuck: 0 });
});

test("disk current and the pane runs on the current binary → complete silence, no event", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.220");
  const cont = containerRunner({ "dev-a": "2.1.220" }, { "dev-a": PANE_A });
  // the binary is older than claude (900 > 300) → the pane is not stale
  const exec = async (c: string, cmd: string[]) => (isBinAge(cmd) ? ok("900\n") : cont.exec(c, cmd));
  const res = await runCcUpkeep(deps({ db, host: host.run, exec }));

  expect(res.updated).toEqual([]);
  expect(res.restarted).toEqual([]);
  expect(cont.calls.some((c) => c.cmd[1] === "send-keys")).toBe(false);
  expect(listEvents(db, {}).length).toBe(0);
});

test("a non-quiet session leaves a trace: a cc_skipped event with the reason", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("busy"));
  const host = hostRunner("2.1.220", "2.1.202");
  const cont = containerRunner({ "dev-busy": "2.1.202" }, { "dev-busy": PANE_A });
  await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec, turnInProgress: () => true }));

  const ev = listEvents(db, { type: "cc_skipped" });
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0]!.data!)).toMatchObject({ reason: "busy", phase: "install", from: "2.1.202", to: "2.1.220" });
});

test("`only` filter: touches only the chosen session", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  insertSession(db, row("b"));
  const host = hostRunner("2.1.220", "2.1.220");
  const cont = containerRunner({ "dev-a": "2.1.202", "dev-b": "2.1.202" }, { "dev-a": PANE_A, "dev-b": PANE_A });
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec }), ["a"]);

  expect(res.updated).toEqual(["a"]);
  expect(cont.calls.some((c) => c.container === "dev-b")).toBe(false);
});

test("without a filter all running sessions are processed", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  insertSession(db, row("b"));
  const host = hostRunner("2.1.220", "2.1.220");
  const cont = containerRunner({ "dev-a": "2.1.202", "dev-b": "2.1.202" }, { "dev-a": PANE_A, "dev-b": PANE_A });
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec }));

  expect(res.updated.sort()).toEqual(["a", "b"]);
});

// Incident on 2026-08-18: cc came back after `--continue`, but stayed stuck on a new
// resume prompt. The job must report it as stuck — and with its own reason, because
// the advice for a human differs from a pane where cc did not come up at all.
const RESUME_DIALOG = `  This session is 3h 36m old and 121.7k tokens.
  Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.
  \u276f 1. Resume from summary (recommended)
    2. Resume full session as-is
    3. Don't ask me again
  Enter to confirm \u00b7 Esc to cancel
`;

test("a pane hanging on the resume dialog → cc_restart_failed { reason: \"stuck-on-dialog\" }", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.220", "2.1.202");
  const notes: string[] = [];
  let exited = false;
  let continued = false;
  const cc = ccVersion("2.1.202");
  const exec = async (_container: string, cmd: string[]): Promise<ExecResult> => {
    if (isBinAge(cmd)) return ok(BIN_AGE);
    if (cmd[0] === "claude") return cc.read();
    if (cmd[0] === "sh") return ok("");
    if (cmd[0] === "sudo") return cc.install(cmd);
    if (cmd[1] === "list-panes") return ok(PANE_A);
    if (cmd[1] === "send-keys") {
      if (cmd[4] === "/exit") exited = true;
      if (/(^|;\s*)cc(\s|$)/.test(cmd[4]!)) continued = true;
      return ok();
    }
    // The cursor in the dialog does not move whatever is pressed — the dialog stays unanswered.
    if (cmd[1] === "capture-pane") return ok(continued ? RESUME_DIALOG : "\u276f\n");
    if (cmd[0] === "ps") return ok(continued ? ps(62) : (exited ? ps() : ps(62)));
    return ok();
  };
  const res = await runCcUpkeep(deps({ db, host: host.run, exec, notify: (_t, m) => { notes.push(m); } }));

  expect(res.restarted).toEqual([]);
  const upgraded = listEvents(db, { type: "cc_upgraded" });
  expect(JSON.parse(upgraded[0]!.data!).restarted).toBe(0);
  expect(JSON.parse(upgraded[0]!.data!).stuck).toBe(1);
  const failed = listEvents(db, { type: "cc_restart_failed" });
  expect(failed.length).toBe(1);
  expect(JSON.parse(failed[0]!.data!)).toEqual({ targets: ["main:0.0"], reason: "stuck-on-dialog" });
});

// Live incident on 2026-08-20: `@anthropic-ai/claude-code@2.1.237` was published on npm 2.5 h
// before its platform binary `…-linux-x64@2.1.237`. That one is an *optional* dependency,
// so npm silently skipped it in that window, deleted the old working one — and still exited
// with zero. Nine containers were left with a shell dummy `bin/claude.exe` and the job
// ran pane restarts on them, so nine sessions with work in progress were left lying there.
test("install exits with zero but cc does not run: no restart, rollback to the old version", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.237", "2.1.237");
  const cont = containerRunner({ "dev-a": "2.1.235" }, { "dev-a": PANE_A }, { installBroken: true });
  const notified: string[] = [];
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: cont.exec, notify: (_t, m) => { notified.push(m); } }));

  expect(res.updated).toEqual([]);                                   // a broken install is not an update
  expect(res.restarted).toEqual([]);
  const sudo = cont.calls.filter((c) => c.cmd[0] === "sudo").map((c) => c.cmd.join(" "));
  expect(sudo).toEqual([
    "sudo npm i -g @anthropic-ai/claude-code@2.1.237",
    "sudo npm i -g @anthropic-ai/claude-code@2.1.235",                // rollback to what worked
  ]);
  expect(cont.calls.some((c) => c.cmd[1] === "send-keys")).toBe(false);   // the pane is not touched
  const ev = listEvents(db, { type: "cc_upgrade_failed" });
  expect(ev.length).toBe(1);
  const data = JSON.parse(ev[0]!.data!);
  expect(data.reason).toBe("verify-failed");
  expect(data.to).toBe("2.1.237");
  expect(data.rolledBack).toBe(true);
  expect(listEvents(db, { type: "cc_upgraded" }).length).toBe(0);
  expect(notified.length).toBe(1);
});

test("a broken install where cc did not run even before: no rollback is attempted", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  const host = hostRunner("2.1.237", "2.1.237");
  // `installBroken` + empty version: `claude --version` fails right the first time → have === null
  const cont = containerRunner({ "dev-a": "2.1.235" }, { "dev-a": PANE_A }, { installBroken: true });
  const brokenFirst = async (container: string, cmd: string[]): Promise<ExecResult> =>
    cmd[0] === "claude" && !cont.calls.some((c) => c.cmd[0] === "sudo")
      ? err("Error: claude native binary not installed.")
      : cont.exec(container, cmd);
  const res = await runCcUpkeep(deps({ db, host: host.run, exec: brokenFirst }));

  expect(res.updated).toEqual([]);
  const sudo = cont.calls.filter((c) => c.cmd[0] === "sudo").map((c) => c.cmd.join(" "));
  expect(sudo).toEqual(["sudo npm i -g @anthropic-ai/claude-code@2.1.237"]);   // there is nothing to go back to
  const data = JSON.parse(listEvents(db, { type: "cc_upgrade_failed" })[0]!.data!);
  expect(data.rolledBack).toBe(false);
});
