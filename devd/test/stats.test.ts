import { expect, test } from "bun:test";
import { deleteSession, getSession, insertSession, openDb } from "../src/db";
import { classifyClaudeState, collectDockerStats, collectGitStats, collectDiskUsage, collectSessionGitStat, parseMem } from "../src/stats";

const sessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms",
  container: "dev-shop-cms", port_base: 40100, status: "running" as const,
  solo: 0 as const, created_at: 1, last_active_at: 1, important: 0 as const,
};

function fakeRun(map: Record<string, { code?: number; stdout?: string }>) {
  return (_cwd: string, ...cmd: string[]) => {
    const key = cmd.join(" ");
    const hit = Object.entries(map).find(([k]) => key.includes(k))?.[1];
    return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "", stderr: "" };
  };
}

test("collectGitStats parses commits, numstat and unpushed", async () => {
  const run = fakeRun({
    "log": { stdout: "a\nb\nc\n" },
    "numstat": { stdout: "3\t1\tfile.ts\n10\t0\tother.ts\n" },
    "rev-list": { stdout: "2\n" },
  });
  expect(await collectGitStats("/ws", run)).toEqual({ commits: 3, added: 13, removed: 1, unpushed: 2 });
});

test("collectGitStats fails to zeros", async () => {
  expect(await collectGitStats("/ws", () => ({ code: 1, stdout: "", stderr: "boom" }))).toEqual({ commits: 0, added: 0, removed: 0, unpushed: 0 });
});

test("collectGitStats trusts the workspace dir (safe.directory) so root over a uid-1000 mount doesn't zero out", async () => {
  // devd runs as root; workspaces are bind-mounted and owned by the container user
  // (uid 1000). Without `-c safe.directory=<dir>` git aborts with "detected dubious
  // ownership" (exit 128) and every stat silently reads zero — the real bug behind
  // "dashboard counts commits wrong".
  const calls: string[][] = [];
  const run = (_cwd: string, ...cmd: string[]) => {
    calls.push(cmd);
    const key = cmd.join(" ");
    if (key.includes("log")) return { code: 0, stdout: "a\nb\n", stderr: "" };
    if (key.includes("numstat")) return { code: 0, stdout: "", stderr: "" };
    if (key.includes("rev-list")) return { code: 0, stdout: "0\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await collectGitStats("/ws", run);
  expect(calls.length).toBeGreaterThan(0);
  for (const cmd of calls) {
    expect(cmd[0]).toBe("git");
    expect(cmd).toContain("safe.directory=/ws");
  }
});

test("collectGitStats accepts an async runner too", async () => {
  const run = async (_cwd: string, ...cmd: string[]) => ({ code: 0, stdout: cmd.includes("log") ? "a\n" : "", stderr: "" });
  expect((await collectGitStats("/ws", run)).commits).toBe(1);
});

test("collectGitStats ignores binary-file numstat lines", async () => {
  const run = fakeRun({
    "log": { stdout: "a\n" },
    "numstat": { stdout: "3\t1\tfile.ts\n-\t-\tbin.png\n" },
    "rev-list": { stdout: "0\n" },
  });
  expect(await collectGitStats("/ws", run)).toEqual({ commits: 1, added: 3, removed: 1, unpushed: 0 });
});

// I2: the stats tick now yields to the event loop between sessions (see index.ts), so between
// the `listSessions` snapshot and writing the stats a session may get ended — and end()
// deletes its git_stats row. Without a re-check collectSessionGitStat would write it
// again and the row would be orphaned forever (git_stats has no FK to sessions, nothing else
// deletes from it) and it would inflate totalUnpushed/totalCommitsToday on the dashboard.
test("collectSessionGitStat does not write git_stats for a session ended during await (I2)", async () => {
  const db = openDb(":memory:");
  insertSession(db, sessionRow);
  const s = getSession(db, sessionRow.id)!;
  const fakeCollect = async () => {
    deleteSession(db, sessionRow.id); // end() ran before the git subprocesses finished
    return { commits: 3, added: 10, removed: 2, unpushed: 1 };
  };
  const wrote = await collectSessionGitStat(db, s, "/ws", fakeCollect);
  expect(wrote).toBe(false);
  expect(db.query("SELECT * FROM git_stats WHERE session_id=?").get(sessionRow.id)).toBeNull();
});

test("collectSessionGitStat writes git_stats when the session still exists", async () => {
  const db = openDb(":memory:");
  insertSession(db, sessionRow);
  const s = getSession(db, sessionRow.id)!;
  const fakeCollect = async () => ({ commits: 1, added: 2, removed: 0, unpushed: 0 });
  const wrote = await collectSessionGitStat(db, s, "/ws", fakeCollect);
  expect(wrote).toBe(true);
  expect(db.query("SELECT * FROM git_stats WHERE session_id=?").get(sessionRow.id)).not.toBeNull();
});

test("collectDiskUsage returns used bytes of the filesystem from statfs", async () => {
  expect(await collectDiskUsage("/ws", () => ({ bsize: 4096, blocks: 1000, bfree: 250 }))).toBe(750 * 4096);
});

test("collectDiskUsage works against the real filesystem", async () => {
  expect(await collectDiskUsage(process.cwd())).toBeGreaterThan(0);
});

test("parseMem returns whole bytes", () => {
  expect(parseMem("590.3MiB")).toBe(Math.round(590.3 * 1024 ** 2));
  expect(Number.isInteger(parseMem("1.5GiB"))).toBe(true);
});

test("collectDockerStats parses json lines", async () => {
  const run = fakeRun({ "stats": { stdout:
    '{"Container":"dev-shop-cms","CPUPerc":"12.5%","MemUsage":"1.5GiB / 64GiB"}\n{"Container":"dev-x","CPUPerc":"0.00%","MemUsage":"512MiB / 64GiB"}\n' } });
  const out = await collectDockerStats(run);
  expect(out[0]).toMatchObject({ container: "dev-shop-cms", cpuPct: 12.5 });
  expect(Math.round(out[0].memBytes / 1e9)).toBe(2); // ~1.5 GiB
  expect(Number.isInteger(out[0].memBytes)).toBe(true);
});

test("collectDockerStats takes the container name from Name, not the ID from Container", async () => {
  const run = fakeRun({ "stats": { stdout:
    '{"Container":"e61a955d9c1d84638e1f","Name":"dev-games-x","CPUPerc":"30.21%","MemUsage":"590.3MiB / 12GiB"}\n' } });
  const out = await collectDockerStats(run);
  expect(out[0]).toMatchObject({ container: "dev-games-x", cpuPct: 30.21, memBytes: Math.round(590.3 * 1024 ** 2) });
  expect(Number.isInteger(out[0].memBytes)).toBe(true);
});

const boom = () => { throw new Error("spawn ENOENT"); };
test("disk/docker collectors swallow spawn errors", async () => {
  expect(await collectDiskUsage("/ws", boom)).toBe(0);
  expect(await collectDockerStats(boom)).toEqual([]);
});

test("classifyClaudeState buckets", () => {
  const now = 1_000_000;
  expect(classifyClaudeState(now - 5_000, now - 5_000, now)).toBe("working");
  expect(classifyClaudeState(now - 5 * 60_000, now - 5 * 60_000, now)).toBe("waiting");
  expect(classifyClaudeState(null, now - 20 * 60_000, now)).toBe("idle");
});

test("classifyClaudeState: a recent metric keeps the session out of idle even after an old prompt", () => {
  const now = 5_000_000;
  // Autonomous work: the prompt was 15 min ago (last_active), but metrics keep flowing (the last one
  // 1 min ago). It must not fall to "idle" (grey "offline") just because of the old prompt → "waiting".
  expect(classifyClaudeState(now - 60_000, now - 15 * 60_000, now)).toBe("waiting");
  // When the metrics went quiet too (>10 min) and the prompt is also old → really idle.
  expect(classifyClaudeState(now - 15 * 60_000, now - 15 * 60_000, now)).toBe("idle");
});
