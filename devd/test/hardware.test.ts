import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { borgReportScript, parseBorgReport } from "../src/borg";
import { RANGES, createBeszel, isRangeKey, pbTime, toSample, toSystem } from "../src/beszel";
import {
  APT_STATUS_FILE, APT_UNIT, DEFAULT_MACHINES, REBOOT_SCRIPT, aptStatusScript, aptUpgradeScript,
  borgWhenIdleScript, createHardware, loadMachines, mergeUnitRun, parseAptStatus, parseStatusFile,
  parseUnitStatus, shQuote, sshArgv, unitStatusScript, type Host, type MachineSpec,
} from "../src/hardware";

/* --------------------------------- borg --------------------------------- */

const BORG_REPORT = `##list
{"archives": [
  {"id": "be813d0e11", "name": "infra-2026-07-25_04-00-41", "start": "2026-07-25T04:00:46.000000"},
  {"id": "4cafd47cff", "name": "infra-2026-07-27_04-02-59", "start": "2026-07-27T04:03:05.000000"},
  {"id": "bc69261caa", "name": "infra-2026-07-26_04-01-41", "start": "2026-07-26T04:01:47.000000"}
], "repository": {"location": "ssh://x/./borg-repo"}}
##info
{"cache": {"stats": {"total_chunks": 272313, "total_csize": 13026816621, "total_size": 88323201096, "unique_csize": 2083817190}}}
##end
`;

test("parseBorgReport sorts archives newest first", () => {
  const r = parseBorgReport(BORG_REPORT);
  expect(r.archives.map((a) => a.name)).toEqual([
    "infra-2026-07-27_04-02-59", "infra-2026-07-26_04-01-41", "infra-2026-07-25_04-00-41",
  ]);
  expect(r.lastArchiveAt).toBe(new Date("2026-07-27T04:03:05").getTime());
});

test("repo size is unique_csize, not total_csize", () => {
  // total_csize is compression WITHOUT dedup — for "how much space it takes" it would overstate.
  const r = parseBorgReport(BORG_REPORT);
  expect(r.storedBytes).toBe(2083817190);
  expect(r.originalBytes).toBe(88323201096);
});

test("broken or empty borg output behaves like an empty repo", () => {
  for (const text of ["", "##list\nborg: error\n##info\nnic\n##end\n"]) {
    const r = parseBorgReport(text);
    expect(r.archives).toEqual([]);
    expect(r.lastArchiveAt).toBeNull();
    expect(r.storedBytes).toBe(0);
  }
});

test("borgReportScript is non-interactive and carries both passphrase and RSH", () => {
  const s = borgReportScript({ repo: "ssh://x/./r", passFile: "/etc/borg/passphrase", rsh: "ssh -p 23", remotePath: "borg-1.4" });
  expect(s).toContain('export BORG_PASSPHRASE="$(cat /etc/borg/passphrase)"');
  expect(s).toContain('export BORG_RSH="ssh -p 23"');
  expect(s).toContain("--remote-path borg-1.4");
  // Without this, borg would prompt about a relocated repo and the SSH connection would hang.
  expect(s).toContain("BORG_RELOCATED_REPO_ACCESS_IS_OK=no");
});

/* ------------------------------ unit status ------------------------------ */

test("parseUnitStatus converts epoch seconds to ms", () => {
  const r = parseUnitStatus(`##unit
started=1785110579
finished=1785110612
next=1785204048
result=success
active=inactive
`);
  expect(r.state).toBe("ok");
  expect(r.startedAt).toBe(1785110579000);
  expect(r.finishedAt).toBe(1785110612000);
  expect(r.nextAt).toBe(1785204048000);
});

test("script runs systemd times through date -d, not directly", () => {
  // `systemctl show -p NextElapseUSecRealtime --value` on newer systemd returns a
  // HUMAN format ("Tue 2026-07-28 02:34:22 CEST"), not microseconds. Verified live.
  const s = unitStatusScript("devbox-backup");
  expect(s).toContain("date -d");
  expect(s).toContain("+%s");
});

test("empty systemd time does not cause NaN", () => {
  const r = parseUnitStatus("##unit\nstarted=\nfinished=\nnext=\nresult=success\nactive=inactive\n");
  expect(r.startedAt).toBeNull();
  expect(r.nextAt).toBeNull();
  expect(r.state).toBe("ok");
});

test("mergeUnitRun: a running unit overrides the state from the file, the message does not", () => {
  const unit = { state: "running", startedAt: 5, finishedAt: null, nextAt: 99, message: null };
  const file = { state: "ok", startedAt: 1, finishedAt: 2, nextAt: null, message: "done" };
  const r = mergeUnitRun(unit, file);
  expect(r.state).toBe("running");
  expect(r.message).toBe("done");
  expect(r.nextAt).toBe(99);            // only the timer knows "when next"
  expect(mergeUnitRun(unit, null)).toEqual(unit);
});

test("a running unit is running regardless of the previous result", () => {
  expect(parseUnitStatus("##unit\nresult=success\nactive=activating\n").state).toBe("running");
});

test("a failed result propagates to both state and message", () => {
  const r = parseUnitStatus("##unit\nresult=exit-code\nactive=failed\n");
  expect(r.state).toBe("failed");
  expect(r.message).toBe("systemd: exit-code");
});

test("a missing section returns unknown, not an exception", () => {
  expect(parseUnitStatus("").state).toBe("unknown");
  expect(parseUnitStatus("##list\n{}\n").nextAt).toBeNull();
});

test("a NONEXISTENT unit is not a success, even though systemd reports Result=success", () => {
  // `systemctl show` on an unknown unit returns `Result=success` as the DEFAULT.
  // Discovered live: the page claimed "last upgrade went fine" for a machine
  // on which apt upgrade had never run.
  const r = parseUnitStatus("##unit\nresult=success\nactive=inactive\nload=not-found\n");
  expect(r.state).toBe("unknown");
  expect(parseUnitStatus("##unit\nresult=success\nactive=inactive\nload=loaded\n").state).toBe("ok");
});

test("unitStatusScript also asks for LoadState", () => {
  expect(unitStatusScript("devbox-backup")).toContain("LoadState");
});

test("unitStatusScript watches both service and timer", () => {
  const s = unitStatusScript("borg-backup");
  expect(s).toContain("borg-backup.service");
  expect(s).toContain("borg-backup.timer");
  expect(s).toContain("NextElapseUSecRealtime");
});

test("parseStatusFile reads the devbox backup status file", () => {
  const r = parseStatusFile('{"state":"ok","message":"archiv devbox-2026-07-27, repo 2.25 GB","startedAt":1785140523000,"finishedAt":1785140556000}')!;
  expect(r.state).toBe("ok");
  expect(r.message).toContain("2.25 GB");
  expect(r.startedAt).toBe(1785140523000);
});

test("an unparseable status file returns null and lets systemd decide", () => {
  expect(parseStatusFile("")).toBeNull();
  expect(parseStatusFile("<html>404</html>")).toBeNull();
});

/* --------------------------------- ssh ---------------------------------- */

test("sshArgv sends the script on STDIN and never waits for a password", () => {
  const argv = sshArgv({ host: "1.2.3.4", port: 2222, user: "root", key: "/root/.ssh/id" });
  expect(argv).toContain("BatchMode=yes");
  expect(argv.slice(-3)).toEqual(["root@1.2.3.4", "bash", "-s"]);
  expect(argv).toContain("-i");
  expect(argv[argv.indexOf("-i") + 1]).toBe("/root/.ssh/id");
});

/* -------------------------------- beszel -------------------------------- */

test("toSample translates Beszel abbreviations into named fields", () => {
  const s = toSample("2026-07-27 09:21:19.831Z", {
    cpu: 17.2, m: 15.62, mu: 7.59, mp: 48.59, s: 16, su: 1.94,
    d: 502.72, du: 87.74, dp: 18.2, dr: 0.16, dw: 23.3,
    b: [31067, 5434575], la: [1.65, 1.3, 1.43],
  });
  expect(s.at).toBe(pbTime("2026-07-27 09:21:19.831Z"));
  expect(s.cpu).toBe(17.2);
  expect(s.memPct).toBe(48.59);
  expect(s.diskUsedGb).toBe(87.74);
  expect(s.swapPct).toBeCloseTo(12.125, 3);
  expect(s.swapUsedGb).toBe(1.94);
  expect(s.swapTotalGb).toBe(16);
  expect(s.netUpKbs).toBeCloseTo(31067 / 1024, 3);
  expect(s.load15).toBe(1.43);
});

test("missing fields in a Beszel record do not produce NaN", () => {
  const s = toSample("2026-07-27 09:21:19.831Z", {});
  for (const v of Object.values(s)) expect(Number.isFinite(v as number)).toBe(true);
  expect(s.swapPct).toBe(0); // division by zero must not leak through
});

test("toSystem extracts the agent version and uptime from info", () => {
  const sys = toSystem({ id: "abc", name: "devbox", status: "up", info: { v: "0.18.7", u: 1730436, cpu: 26.29, mp: 22.76, dp: 3.55 } });
  expect(sys).toEqual({ id: "abc", name: "devbox", status: "up", agentVersion: "0.18.7", uptimeSec: 1730436, cpu: 26.29, memPct: 22.76, diskPct: 3.55 });
});

test("chart ranges have increasing granularity", () => {
  expect(Object.keys(RANGES)).toEqual(["1h", "6h", "24h", "7d"]);
  expect(isRangeKey("6h")).toBe(true);
  expect(isRangeKey("30d")).toBe(false);
});

test("a missing coarser aggregation falls back to a finer one instead of an empty chart", async () => {
  // A freshly added agent has ONLY `1m` rows for the first few hours (verified live on
  // the devbox: 10m/20m totalItems = 0). Without the fallback the chart would stay empty.
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("auth-with-password")) return Response.json({ token: "t" });
    const type = decodeURIComponent(u).match(/type="([^"]+)"/)![1];
    asked.push(type);
    return Response.json({ items: type === "1m" ? [{ created: "2026-07-27 09:21:19.831Z", stats: { cpu: 5 } }] : [] });
  }) as unknown as typeof fetch;
  const b = createBeszel({ url: "https://h", email: "e", password: "p" }, fetchImpl);
  const rows = await b.samples("sys", "24h");
  expect(asked).toEqual(["20m", "10m", "1m"]);
  expect(rows).toHaveLength(1);
  expect(rows[0].cpu).toBe(5);
});

test("when no granularity has data, empty is returned without an exception", async () => {
  const fetchImpl = (async (url: string | URL) =>
    (String(url).includes("auth-with-password") ? Response.json({ token: "t" }) : Response.json({ items: [] }))) as unknown as typeof fetch;
  const b = createBeszel({ url: "https://h", email: "e", password: "p" }, fetchImpl);
  expect(await b.samples("sys", "7d")).toEqual([]);
});

test("after the token expires the client logs in again and retries the request", async () => {
  let logins = 0, first = true;
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes("auth-with-password")) { logins++; return Response.json({ token: `t${logins}` }); }
    if (first) { first = false; return new Response("", { status: 401 }); }
    return Response.json({ items: [{ id: "a", name: "box", status: "up", info: {} }] });
  }) as unknown as typeof fetch;
  const b = createBeszel({ url: "https://h", email: "e", password: "p" }, fetchImpl);
  expect((await b.systems())[0].name).toBe("box");
  expect(logins).toBe(2);
});

/* ------------------------------ orchestration ---------------------------- */

const SPEC: MachineSpec[] = [
  {
    id: "box", label: "box", beszelName: "box", host: "local",
    backup: { repo: "ssh://x/./r", passFile: "/p", unit: "b", statusFile: "/var/lib/devd/backup-status.json", pull: [{ label: "L", command: "rsync x y" }] },
  },
  {
    id: "far", label: "far", beszelName: null, host: "remote",
    backup: { repo: "ssh://y/./r", passFile: "/q", unit: "c", pull: [] },
  },
];

const HOST_OUT = "##host\nhostname=box\nuptime_s=10\n##updates\nreboot=0\n";
const UNIT_OUT = "##unit\nstarted=1785110579\nresult=success\nactive=inactive\n";

/** The "machine's" reply: returns sections according to what the script contains. */
function reply(script: string): string {
  let out = "";
  if (script.includes("uptime_s")) out += HOST_OUT;
  if (script.includes("borg list")) out += BORG_REPORT.replace("##end\n", "");
  if (script.includes("systemctl show")) out += UNIT_OUT;
  if (script.includes("backup-status.json")) out += '##status\n{"state":"ok","message":"done"}\n';
  if (script.includes("##done")) out += "##done\n";
  return out;
}

function deps(clock = { t: 5_000_000 }, run?: (host: Host, script: string) => { code: number; stdout: string; stderr?: string }) {
  return {
    machines: SPEC,
    now: () => clock.t,
    run: async (host: Host, script: string) => ({ stderr: "", ...(run ? run(host, script) : { code: 0, stdout: reply(script) }) }),
    beszel: {
      systems: async () => [{ id: "s1", name: "box", status: "up", agentVersion: "0.18.7", uptimeSec: 1, cpu: 1, memPct: 2, diskPct: 3 }],
      samples: async () => [],
    },
  };
}

test("snapshot combines Beszel, probe and backup into one machine", async () => {
  const hw = createHardware(deps() as never);
  await hw.tick();
  const m = hw.snapshot().machines[0];
  expect(m.beszel?.agentVersion).toBe("0.18.7");
  expect(m.host?.hostname).toBe("box");
  expect(m.backup?.repo?.archives).toHaveLength(3);
  expect(m.backup?.state).toBe("ok");
  expect(m.backup?.message).toBe("done");       // the status file overrides systemd
  expect(m.errors).toEqual([]);
});

test("an instance that has not ticked is empty, not broken", () => {
  const snap = createHardware(deps() as never).snapshot();
  expect(snap.machines).toHaveLength(2);
  expect(snap.machines[0].host).toBeNull();
  expect(snap.machines[0].backup).toBeNull();
  expect(snap.storageBox).toBeNull();
  expect(snap.errors).toEqual([]);
});

test("a machine without a Beszel agent has only probe and backup", async () => {
  const hw = createHardware(deps() as never);
  await hw.tick();
  await hw.tick();                       // the second machine's backup turn comes only now
  expect(hw.snapshot().machines[1].beszel).toBeNull();
  expect(hw.snapshot().machines[1].host?.hostname).toBe("box");
  expect(hw.snapshot().machines[1].backup?.repo?.archives).toHaveLength(3);
});

test("ONE MACHINE = ONE SSH CONNECTION PER TICK", async () => {
  // infra has ufw `limit` on 2222 (6 new connections / 30 s → REJECT). Splitting probe,
  // borg and systemctl into separate calls hit it live. Regression guard.
  const calls: { host: Host; script: string }[] = [];
  const hw = createHardware({
    ...deps(),
    run: async (host: Host, script: string) => { calls.push({ host, script }); return { code: 0, stdout: reply(script), stderr: "" }; },
  } as never);
  await hw.tick();
  expect(calls).toHaveLength(2);                        // one per machine, not five
  expect(calls.filter((c) => c.host === "remote")).toHaveLength(1);
  // and that one script really carries everything
  const local = calls.find((c) => c.host === "local")!.script;
  for (const needle of ["uptime_s", "borg list", "borg info", "systemctl show", "backup-status.json"]) {
    expect(local).toContain(needle);
  }
});

test("at most one backup per tick, and machines take turns", async () => {
  // Two repos at once = 2 (devbox borg) + 1 (infra probe) connections in one second, and
  // there would be no headroom left for the ufw limit or for a human logging in right then.
  const calls: { host: Host; borg: boolean }[] = [];
  const clock = { t: 5_000_000 };
  const hw = createHardware({
    ...deps(clock),
    run: async (host: Host, script: string) => {
      calls.push({ host, borg: script.includes("borg list") });
      return { code: 0, stdout: reply(script), stderr: "" };
    },
  } as never);
  await hw.tick();
  expect(calls.filter((c) => c.borg)).toHaveLength(1);
  const firstBorgHost = calls.find((c) => c.borg)!.host;

  calls.length = 0;
  clock.t += 16 * 60_000;                    // both borgs overdue
  await hw.tick();
  expect(calls.filter((c) => c.borg)).toHaveLength(1);
  // the other machine's turn is now (the longest-unchecked one is taken)
  expect(calls.find((c) => c.borg)!.host).not.toBe(firstBorgHost);
});

test("a probe outage keeps the last known value and only adds an error", async () => {
  let broken = false;
  const clock = { t: 5_000_000 };
  const hw = createHardware(deps(clock, (_h, s) => (broken
    ? { code: 255, stdout: "", stderr: "ssh: connect to host 192.0.2.12 port 2222: Connection refused" }
    : { code: 0, stdout: reply(s) })) as never);
  await hw.tick();
  expect(hw.snapshot().machines[0].host?.hostname).toBe("box");
  expect(hw.snapshot().machines[0].errors).toEqual([]);

  broken = true;
  clock.t += 6 * 60_000;                 // host is overdue, borg not yet
  await hw.tick();
  const snap = hw.snapshot();
  expect(snap.machines[0].host?.hostname).toBe("box");             // the old value holds
  expect(snap.machines[0].errors[0]).toContain("Connection refused");
  expect(snap.machines[0].backup?.repo?.archives).toHaveLength(3); // borg stayed from last time
});

test("borg without archives is an error, not silent emptiness", async () => {
  const hw = createHardware(deps({ t: 5_000_000 }, (_h, s) => ({
    code: 0,
    // the connection went through, but borg returned nothing (locked repo / wrong passphrase)
    stdout: reply(s).replace(BORG_REPORT.replace("##end\n", ""), "##list\n##info\n"),
  })) as never);
  await hw.tick();
  expect(hw.snapshot().machines[0].errors.join()).toContain("no archives");
});

test("tick does not repeat a source that is not yet overdue", async () => {
  const calls: string[] = [];
  const clock = { t: 5_000_000 };
  const hw = createHardware({
    ...deps(clock),
    run: async (_h: Host, s: string) => { calls.push(s); return { code: 0, stdout: reply(s), stderr: "" }; },
  } as never);
  await hw.tick();
  expect(calls).toHaveLength(2);
  await hw.tick();                       // second backup (deferred from the first tick)
  expect(calls).toHaveLength(3);
  await hw.tick();                       // nothing is overdue now
  expect(calls).toHaveLength(3);
  clock.t += 6 * 60_000;                 // after the host interval (5 min), before borg (15 min)
  await hw.tick();
  expect(calls).toHaveLength(5);
  expect(calls[3]).toContain("uptime_s");
  expect(calls[3]).not.toContain("borg list");   // borg should not run again yet
});

test("storageBox counts only the repo with quotaBytes", async () => {
  const quota = 1024 ** 4;
  const hw = createHardware({ ...deps(), machines: [{ ...SPEC[1], backup: { ...SPEC[1].backup!, quotaBytes: quota } }] } as never);
  await hw.tick();
  const sb = hw.snapshot().storageBox!;
  expect(sb.usedBytes).toBe(2083817190);
  expect(sb.totalBytes).toBe(quota);
});

test("storageBox without quotaBytes is absent", async () => {
  const hw = createHardware(deps() as never);
  await hw.tick();
  expect(hw.snapshot().storageBox).toBeNull();
});

test("runBackup starts the unit non-blocking and does not evaluate the exit code", async () => {
  const seen: string[] = [];
  const hw = createHardware({
    ...deps(),
    // `systemctl start` on Type=oneshot returns 3 even on success — a past pitfall.
    run: async (_h: Host, s: string) => { seen.push(s); return { code: 3, stdout: reply(s), stderr: "" }; },
  } as never);
  await hw.runBackup("box");
  expect(seen).toContain("systemctl start --no-block b.service");
});

test("a running backup does not overwrite the archive list with emptiness", async () => {
  // Verified live after clicking "Back up now": borg create holds the repo lock,
  // `borg list` returns nothing, and without this a zero would be stored for 15 minutes.
  let busy = false;
  const clock = { t: 5_000_000 };
  // Just one machine, so backup rotation between machines does not interfere.
  const hw = createHardware({
    ...deps(clock, (_h, s) => ({
      code: 0,
      stdout: busy && s.includes("borg list")
        ? HOST_OUT + "##busy\n##unit\nresult=success\nactive=activating\n##status\n{\"state\":\"running\"}\n##done\n"
        : reply(s),
    })),
    machines: [SPEC[0]],
  } as never);
  await hw.tick();
  expect(hw.snapshot().machines[0].backup?.repo?.archives).toHaveLength(3);

  busy = true;
  clock.t += 16 * 60_000;
  await hw.tick();
  const m = hw.snapshot().machines[0];
  expect(m.backup?.state).toBe("running");
  expect(m.backup?.repo?.archives).toHaveLength(3);   // the old list holds
  expect(m.errors).toEqual([]);                       // and it is not an error

  // and it retries in a minute, not in fifteen
  busy = false;
  clock.t += 61_000;
  await hw.tick();
  expect(hw.snapshot().machines[0].backup?.state).toBe("ok");
});

test("borgWhenIdleScript runs the listing only when no backup is running", () => {
  const s = borgWhenIdleScript({ repo: "r", passFile: "/p", unit: "b", pull: [] });
  expect(s).toContain("systemctl is-active --quiet b.service");
  expect(s).toContain("##busy");
  expect(s).toContain("borg list");
});

// Feedback for the "Back up now" button: without an optimistic write the snapshot showed
// the old state until the next tick (30 s) + FE poll (20 s) — the user clicked and for up to
// a minute NOTHING changed. runUpgrade already does this; backup must do the same.
test("runBackup switches the backup state to running right away, before the first tick arrives", async () => {
  const hw = createHardware(deps() as never);
  await hw.tick();                                  // the slot has a value from the probe
  await hw.runBackup("box");
  const m = hw.snapshot().machines.find((x) => x.id === "box")!;
  expect(m.backup?.state).toBe("running");
  expect(m.backup?.finishedAt).toBeNull();
});

test("runBackup of an unknown machine is an error, not silence", async () => {
  const hw = createHardware(deps() as never);
  await expect(hw.runBackup("missing")).rejects.toThrow();
});

/* ---------------------------- host maintenance --------------------------- */

test("apt upgrade runs detached so an SSH outage does not kill it", () => {
  const s = aptUpgradeScript();
  expect(s).toContain("systemd-run");
  expect(s).toContain(`--unit=${APT_UNIT}`);
  // Without reset-failed a second run would fail with "unit already exists".
  expect(s).toContain("reset-failed");
  // The script writes the result itself — we must not ask systemd for it, see the test below.
  expect(s).toContain(APT_STATUS_FILE);
});

test("apt status is not read via systemctl because that spams the journal", () => {
  // systemd cleans up a transient unit after it finishes, and `systemctl show` on it then
  // logs "Failed to open /run/systemd/transient/… No such file" — six lines
  // per probe, forever. Verified live after the first run from the dashboard.
  const s = aptStatusScript();
  expect(s).not.toContain("systemctl");
  expect(s).toContain(APT_STATUS_FILE);
  expect(s).toContain("/sys/fs/cgroup");   // liveness via cgroup, not via systemd
});

test("parseAptStatus: without a status file it is null, not success", () => {
  expect(parseAptStatus("")).toBeNull();
  expect(parseAptStatus("##apt\nlive=0\n\n")).toBeNull();
});

test("parseAptStatus reads the result from the file", () => {
  const r = parseAptStatus('##apt\nlive=0\n{"state":"ok","startedAt":1000,"finishedAt":2000,"message":"12 packages upgraded"}\n')!;
  expect(r.state).toBe("ok");
  expect(r.message).toBe("12 packages upgraded");
  expect(r.finishedAt).toBe(2000);
});

test("running per the file + dead cgroup = upgrade died, not running", () => {
  const running = '##apt\nlive=1\n{"state":"running","startedAt":1000,"finishedAt":1000,"message":""}\n';
  expect(parseAptStatus(running)!.state).toBe("running");
  const died = running.replace("live=1", "live=0");
  const r = parseAptStatus(died)!;
  expect(r.state).toBe("failed");
  expect(r.message).toContain("did not finish");
});

test("the nested script is in SINGLE quotes so the outer shell does not expand it", () => {
  // `JSON.stringify` (double quotes) broke everything here: the outer bash expanded
  // $1, $S and $(date) before systemd-run saw them, and turned newlines into
  // a literal "\\n" → "syntax error near unexpected token `('". Discovered live.
  const s = aptUpgradeScript();
  const inner = s.slice(s.indexOf("bash -lc ") + 9);
  expect(inner.startsWith("'")).toBe(true);
  expect(inner.trimEnd().endsWith("'")).toBe(true);
  expect(inner).toContain("\n");                 // real line endings
  expect(inner).not.toContain("\\n\"");          // not escaped in double quotes
  expect(inner).toContain('"$S"');               // variables stay unexpanded
  expect(inner).toContain("$(date +%s)");
});

test("shQuote escapes nested single quotes", () => {
  expect(shQuote("echo hello")).toBe("'echo hello'");
  // printf in the script has its own '...' — without escaping the quotes would fall apart.
  expect(shQuote(`printf 'x'`)).toBe(`'printf '\\''x'\\'''`);
  expect(shQuote("a\nb")).toBe("'a\nb'");         // line endings survive
});

test("apt upgrade uninstalls nothing and does not overwrite config files", () => {
  const s = aptUpgradeScript();
  expect(s).toContain("apt-get update");
  expect(s).toContain("--with-new-pkgs upgrade");   // so the pending list empties
  expect(s).not.toContain("dist-upgrade");          // that can REMOVE packages
  expect(s).not.toContain("full-upgrade");
  expect(s).toContain("--force-confold");           // we will not let sshd_config be overwritten
  expect(s).toContain("DEBIAN_FRONTEND=noninteractive");
});

test("runUpgrade reports an error when the unit was not created", async () => {
  const hw = createHardware(deps({ t: 5_000_000 }, () => ({ code: 1, stdout: "", stderr: "Failed to start transient service" })) as never);
  await expect(hw.runUpgrade("box")).rejects.toThrow(/could not be started/);
});

test("runUpgrade switches the state to running right away so the user does not wait for a tick", async () => {
  const hw = createHardware(deps() as never);
  await hw.runUpgrade("box");
  expect(hw.snapshot().machines[0].upgrade?.state).toBe("running");
});

test("apt status is read together with the probe and a running upgrade speeds up the next probe", async () => {
  const calls: string[] = [];
  const clock = { t: 5_000_000 };
  let apt = '##apt\nlive=1\n{"state":"running","startedAt":1000,"finishedAt":1000,"message":""}\n';
  const hw = createHardware({
    ...deps(clock),
    run: async (_h: Host, s: string) => {
      calls.push(s);
      return { code: 0, stdout: reply(s) + (s.includes("##apt") ? apt : ""), stderr: "" };
    },
  } as never);
  await hw.tick();
  expect(hw.snapshot().machines[0].upgrade?.state).toBe("running");

  // During an upgrade the probe repeats after ~20 s, not after 5 minutes.
  calls.length = 0;
  clock.t += 25_000;
  await hw.tick();
  expect(calls.some((c) => c.includes("uptime_s"))).toBe(true);

  apt = '##apt\nlive=0\n{"state":"ok","startedAt":1000,"finishedAt":2000,"message":"12 packages upgraded"}\n';
  clock.t += 6 * 60_000;
  await hw.tick();
  expect(hw.snapshot().machines[0].upgrade?.state).toBe("ok");
});

test("a missing status file does not overwrite the earlier result", async () => {
  // If a missing file overwrote "done", after a cleanup of /var/lib the page
  // would claim that nothing was ever updated.
  const clock = { t: 5_000_000 };
  let apt = '##apt\nlive=0\n{"state":"ok","startedAt":1000,"finishedAt":2000,"message":"done"}\n';
  const hw = createHardware({
    ...deps(clock),
    run: async (_h: Host, s: string) => ({ code: 0, stdout: reply(s) + (s.includes("##apt") ? apt : ""), stderr: "" }),
  } as never);
  await hw.tick();
  expect(hw.snapshot().machines[0].upgrade?.state).toBe("ok");

  apt = "##apt\nlive=0\n\n";                        // the file disappeared
  clock.t += 6 * 60_000;
  await hw.tick();
  expect(hw.snapshot().machines[0].upgrade?.state).toBe("ok");
});

test("reboot is --no-block because on the devbox we kill ourselves", async () => {
  const seen: string[] = [];
  const hw = createHardware({
    ...deps(),
    run: async (_h: Host, s: string) => { seen.push(s); return { code: 0, stdout: reply(s), stderr: "" }; },
  } as never);
  await hw.reboot("box");
  expect(seen).toContain("systemctl reboot --no-block");
  expect(REBOOT_SCRIPT).toContain("--no-block");
});

test("maintenance of an unknown machine is an error, not silence", async () => {
  const hw = createHardware(deps() as never);
  await expect(hw.runUpgrade("missing")).rejects.toThrow();
  await expect(hw.reboot("missing")).rejects.toThrow();
});

test("machine registry: without hardware.json only the local machine", () => {
  expect(loadMachines("/missing/hardware.json")).toBe(DEFAULT_MACHINES);
  expect(DEFAULT_MACHINES.map((m) => m.host)).toEqual(["local"]);
});

test("machine registry: loads JSON and rejects an unknown host", () => {
  const dir = mkdtempSync(join(tmpdir(), "hw-"));
  const p = join(dir, "hardware.json");
  writeFileSync(p, JSON.stringify(SPEC));
  expect(loadMachines(p).map((m) => m.id)).toEqual(["box", "far"]);
  writeFileSync(p, JSON.stringify([{ ...SPEC[1], host: "ssh" }]));
  expect(() => loadMachines(p)).toThrow(/host/);
});

test("infra/hardware.example.json is a valid registry", () => {
  const ms = loadMachines(new URL("../../infra/hardware.example.json", import.meta.url).pathname);
  // Every machine has all commands on one host — otherwise "one connection per tick" would break.
  for (const m of ms) expect(m.host === "local" || m.host === "remote").toBe(true);
  expect(ms.filter((m) => m.backup?.quotaBytes)).toHaveLength(1);
});
