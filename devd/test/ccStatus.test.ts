import { expect, test } from "bun:test";
import { insertSession, openDb } from "../src/db";
import { ccStatus, type ExecResult, type UpkeepDeps } from "../src/ccUpkeep";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const err = (): ExecResult => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });

let nextPort = 40100;
const row = (id: string) => ({
  id, folder: "apps", project: "apps", repo: id, container: `dev-${id}`, port_base: nextPort++,
  status: "running" as const, solo: 0 as const, created_at: 0, last_active_at: 0, important: 0 as const,
});

// pane 62 → bash → claude 1062 (running 300 s), pane 72 → bash → claude 1072 (running 30 s).
const PANES = "main:0.0\t62\nmain-2:0.0\t72\n";
const PS = "   62    61 900 bash\n 1062    62 300 claude\n   72    61 900 bash\n 1072    72 30 claude\n";
const isBinAge = (cmd: string[]) => cmd[0] === "sh" && (cmd[2] ?? "").includes("stat -c");
const isBusy = (cmd: string[]) => cmd[0] === "sh" && !isBinAge(cmd);

function deps(over: Partial<UpkeepDeps>): UpkeepDeps {
  return {
    db: openDb(":memory:"), exec: async () => ok(), host: async () => ok(),
    turnInProgress: () => false, notify: () => {}, sleep: async () => {},
    repoDir: "/opt/vps-dev-infra", image: "devbox:latest", ...over,
  };
}

function host(latest: string, image: string) {
  return async (cmd: string[]): Promise<ExecResult> => {
    if (cmd.includes("npm")) return ok(`${latest}\n`);
    if (cmd.includes("claude")) return ok(`${image} (Claude Code)\n`);
    return ok();
  };
}

test("ccStatus: version, panes, staleness and load together", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("a"));
  // binary is 100 s old → claude 1062 (300 s) is stale, 1072 (30 s) is not
  const exec = async (_c: string, cmd: string[]): Promise<ExecResult> => {
    if (isBinAge(cmd)) return ok("100\n");
    if (isBusy(cmd)) return ok("1062 4\n1072 61\n");
    if (cmd[0] === "claude") return ok("2.1.207 (Claude Code)\n");
    if (cmd[1] === "list-panes") return ok(PANES);
    if (cmd[0] === "ps") return ok(PS);
    return ok();
  };
  const st = await ccStatus(deps({ db, exec, host: host("2.1.220", "2.1.220") }));

  expect(st.latest).toBe("2.1.220");
  expect(st.image).toBe("2.1.220");
  expect(st.sessions).toEqual([
    { id: "a", project: "apps", repo: "a", version: "2.1.207", panes: 2, stalePanes: 1, busyPct: 61 },
  ]);
});

test("ccStatus: an unreachable container gives a null version and does not bring down the rest", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("dead"));
  insertSession(db, row("live"));
  const exec = async (c: string, cmd: string[]): Promise<ExecResult> => {
    if (c === "dev-dead") return err();
    if (isBinAge(cmd)) return ok("100\n");
    if (isBusy(cmd)) return ok("1062 2\n");
    if (cmd[0] === "claude") return ok("2.1.220 (Claude Code)\n");
    if (cmd[1] === "list-panes") return ok("main:0.0\t62\n");
    if (cmd[0] === "ps") return ok("   62    61 900 bash\n 1062    62 300 claude\n");
    return ok();
  };
  const st = await ccStatus(deps({ db, exec, host: host("2.1.220", "2.1.220") }));

  const dead = st.sessions.find((s) => s.id === "dead")!;
  expect(dead).toEqual({ id: "dead", project: "apps", repo: "dead", version: null, panes: null, stalePanes: null, busyPct: null });
  expect(st.sessions.find((s) => s.id === "live")!.version).toBe("2.1.220");
});

test("ccStatus: stopped sessions are not scanned", async () => {
  const db = openDb(":memory:");
  insertSession(db, { ...row("stopped"), status: "stopped" as const });
  let touched = 0;
  const st = await ccStatus(deps({ db, exec: async () => { touched++; return ok(); }, host: host("2.1.220", "2.1.220") }));
  expect(st.sessions).toEqual([]);
  expect(touched).toBe(0);
});

test("ccStatus: without a claude process the load is 0, not null", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("idle"));
  const exec = async (_c: string, cmd: string[]): Promise<ExecResult> => {
    if (isBinAge(cmd)) return ok("100\n");
    if (isBusy(cmd)) return ok("");                       // pgrep found nothing
    if (cmd[0] === "claude") return ok("2.1.220 (Claude Code)\n");
    if (cmd[1] === "list-panes") return ok("main:0.0\t62\n");
    if (cmd[0] === "ps") return ok("   62    61 900 zsh\n");
    return ok();
  };
  const st = await ccStatus(deps({ db, exec, host: host("2.1.220", "2.1.220") }));
  expect(st.sessions[0]).toMatchObject({ panes: 0, stalePanes: 0, busyPct: 0 });
});

// Critical: when ONLY the process listing fails, it must not come out as "0 panes, all
// fine" — panes cannot be counted without the process table, so it is "unknown".
test("ccStatus: only ps fails → panes are null, not zero", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("partial"));
  const exec = async (_c: string, cmd: string[]): Promise<ExecResult> => {
    if (cmd[0] === "ps") return err();
    if (isBinAge(cmd)) return ok("100\n");
    if (isBusy(cmd)) return ok("1062 61\n");
    if (cmd[0] === "claude") return ok("2.1.207 (Claude Code)\n");
    if (cmd[1] === "list-panes") return ok(PANES);
    return ok();
  };
  const st = await ccStatus(deps({ db, exec, host: host("2.1.220", "2.1.220") }));
  expect(st.sessions[0]).toEqual({
    id: "partial", project: "apps", repo: "partial",
    version: "2.1.207", panes: null, stalePanes: null, busyPct: 61,
  });
});

test("ccStatus: only the load sample fails → busyPct null, panes counted", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("nobusy"));
  const exec = async (_c: string, cmd: string[]): Promise<ExecResult> => {
    if (isBinAge(cmd)) return ok("100\n");
    if (isBusy(cmd)) return err();
    if (cmd[0] === "claude") return ok("2.1.220 (Claude Code)\n");
    if (cmd[1] === "list-panes") return ok(PANES);
    if (cmd[0] === "ps") return ok(PS);
    return ok();
  };
  const st = await ccStatus(deps({ db, exec, host: host("2.1.220", "2.1.220") }));
  expect(st.sessions[0]).toMatchObject({ panes: 2, stalePanes: 1, busyPct: null });
});

test("ccStatus: only the binary age fails → stalePanes null, panes counted", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("noage"));
  const exec = async (_c: string, cmd: string[]): Promise<ExecResult> => {
    if (isBinAge(cmd)) return err();
    if (isBusy(cmd)) return ok("1062 4\n");
    if (cmd[0] === "claude") return ok("2.1.220 (Claude Code)\n");
    if (cmd[1] === "list-panes") return ok(PANES);
    if (cmd[0] === "ps") return ok(PS);
    return ok();
  };
  const st = await ccStatus(deps({ db, exec, host: host("2.1.220", "2.1.220") }));
  expect(st.sessions[0]).toMatchObject({ panes: 2, stalePanes: null });
});

// The host query may fail without all sessions losing their data.
test("ccStatus: an exception from the host call does not cancel the session scan", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("live2"));
  const exec = async (_c: string, cmd: string[]): Promise<ExecResult> => {
    if (isBinAge(cmd)) return ok("100\n");
    if (isBusy(cmd)) return ok("1062 3\n");
    if (cmd[0] === "claude") return ok("2.1.220 (Claude Code)\n");
    if (cmd[1] === "list-panes") return ok(PANES);
    if (cmd[0] === "ps") return ok(PS);
    return ok();
  };
  const st = await ccStatus(deps({ db, exec, host: async () => { throw new Error("docker mimo"); } }));
  expect(st.latest).toBeNull();
  expect(st.image).toBeNull();
  expect(st.sessions[0]).toMatchObject({ version: "2.1.220", panes: 2 });
});
