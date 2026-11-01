import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestRecoveryRecords, ownerAlive, parseRecoveryRecord, recoveryLaunchConfig, sameRecoveryServer, terminalRecoveryStore, waitForSavedSession, warpPaneId, type TerminalRecoveryRecord } from "../src/recovery";
import { snapshotWarpConnectionPlan, snapshotWarpConnections, type SnapshotDeps } from "../src/recoverySnapshot";
import { installWarpRecovery } from "../install-recovery";
import { tmuxCommand } from "../src/attach";
import type { SessionInfo } from "../src/api";
import type { RecoveryOwnerDeps } from "../src/recoveryOwner";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "dev-recovery-")); dirs.push(dir); return dir; };
const pane = "0123456789abcdef0123456789abcdef";
const record: TerminalRecoveryRecord = { version: 1, paneId: pane, sessionId: "ses-1", container: "dev-1", tmuxSession: "main-3",
  devdUrl: "http://127.0.0.1:4300", label: "shop/web", attachedAt: 123, ownerPid: 99999999 };
const live = { id: record.sessionId, container: record.container, status: "running", project: "shop", repo: "web",
  tmux: [{ name: "main-3" }] } as SessionInfo;

test("uses Warp's persistent UUID and rejects the legacy shell bootstrap id", () => {
  expect(warpPaneId({ TERM_PROGRAM: "WarpTerminal", WARP_SESSION_ID: "12345" })).toBeUndefined();
  expect(warpPaneId({ TERM_PROGRAM: "WarpTerminal", WARP_TERMINAL_SESSION_UUID: pane.toUpperCase() })).toBe(pane);
  expect(warpPaneId({ TERM_PROGRAM: "other", WARP_TERMINAL_SESSION_UUID: pane })).toBeUndefined();
});

test("parallel panes persist separately, atomically; owner cleanup cannot delete a replacement", () => {
  const dir = temp(), store = terminalRecoveryStore(dir);
  store.write(record);
  store.write({ ...record, paneId: "a".repeat(32), tmuxSession: "main-4" });
  expect(store.list()).toHaveLength(2);
  expect(statSync(join(dir, `${pane}.json`)).mode & 0o777).toBe(0o600);
  store.write({ ...record, ownerPid: 42 });
  store.forget(pane, record.ownerPid);
  expect(store.read(pane)?.ownerPid).toBe(42);
  store.forget(pane, 42);
  expect(store.read(pane)).toBeUndefined();
});

test("duplicate stale pane records choose the newest exact target without merging distinct tmux sessions", () => {
  const newer = { ...record, paneId: "a".repeat(32), attachedAt: record.attachedAt + 1 };
  const other = { ...record, paneId: "b".repeat(32), tmuxSession: "main-4" };
  expect(newestRecoveryRecords([record, newer, other])).toEqual([newer, other]);
});

test("malformed, mismatched and shell-injection records fail closed", () => {
  const dir = temp(), store = terminalRecoveryStore(dir);
  writeFileSync(join(dir, `${pane}.json`), "{");
  expect(store.list()).toEqual([]);
  writeFileSync(join(dir, `${pane}.json`), JSON.stringify({ ...record, paneId: "a".repeat(32) }));
  expect(store.read(pane)).toBeUndefined();
  expect(parseRecoveryRecord({ ...record, tmuxSession: "main; touch /tmp/no" })).toBeUndefined();
  expect(parseRecoveryRecord({ ...record, devdUrl: "http://user:secret@host" })).toBeUndefined();
  expect(sameRecoveryServer(record, { devdUrl: record.devdUrl + "/" })).toBe(true);
  expect(sameRecoveryServer(record, { devdUrl: "http://other:4300" })).toBe(false);
});

test("replacement window quotes paths and metadata and resumes exact saved panes", () => {
  const text = recoveryLaunchConfig([{ ...record, label: 'web: "quoted"\nnext' }], "/Users/A B", "/Users/A B/dev's.ts", "/opt/bun");
  const config = Bun.YAML.parse(text) as any;
  expect(config.windows[0].tabs[0].title).toBe('web: "quoted"\nnext');
  expect(config.windows[0].tabs[0].layout.cwd).toBe("/Users/A B");
  expect(config.windows[0].tabs[0].layout.commands[0].exec).toContain(`'resume' '--pane' '${pane}'`);
  expect(config.windows[0].tabs[0].layout.commands[0].exec).toContain("dev'\\''s.ts");
});

test("restoration waits for exact tmux after server/network boot without accepting a prefix", async () => {
  let attempt = 0, now = 0;
  const result = await waitForSavedSession(record, {
    sessions: async () => { if (++attempt === 1) throw new Error("offline"); return [attempt === 2 ? { ...live, tmux: [{ name: "main-30" }] as never } : live]; },
    sleep: async (ms) => { now += ms; }, now: () => now,
  });
  expect(result.id).toBe(record.sessionId);
  expect(attempt).toBe(3);
});

test("restoration refuses stopped or mismatched containers and keeps bounded offline wait", async () => {
  const deps = { sleep: async () => {}, sessions: async () => [{ ...live, status: "stopped" } as SessionInfo] };
  await expect(waitForSavedSession(record, deps)).rejects.toThrow("stopped");
  await expect(waitForSavedSession(record, { ...deps, sessions: async () => [{ ...live, container: "other" }] })).rejects.toThrow("no longer matches");
  let now = 0;
  await expect(waitForSavedSession(record, { sessions: async () => { throw new Error("offline"); }, sleep: async (ms) => { now += ms; }, now: () => now, timeoutMs: 5000 })).rejects.toThrow("not restored");
});

test("exact resume never creates a fresh/default agent and rejects unsafe tmux input", () => {
  const cmd = tmuxCommand("main-3", true, true);
  expect(cmd).toContain("has-session -t =main-3 2>/dev/null || exit 44");
  expect(cmd).not.toContain("new-session");
  expect(cmd).not.toContain("agent-launch");
  expect(cmd).toContain("@devd_warp_grok_native 1");
  expect(() => tmuxCommand("main; touch /tmp/no")).toThrow();
});

const processDeps = (sshCommand = "ssh devbox docker exec -it dev-1 bash -lc 'tmux has-session -t =main-3; tmux attach -d -t =main-3'"): SnapshotDeps => ({
  processes: () => [{ pid: 10, ppid: 1, executable: "bun" }, { pid: 11, ppid: 10, executable: "ssh" }],
  command: (pid) => pid === 10 ? "bun /Users/me/.bun/bin/dev shop/web" : sshCommand,
  warpEnvironment: () => ({ TERM_PROGRAM: "WarpTerminal", WARP_TERMINAL_SESSION_UUID: pane }),
});

const identity = { bootId: "darwin:100000:1234", startedAt: "Fri Sep 11 12:34:56 2026" };
const identityRecord = { ...record, ownerPid: 10, ownerIdentity: identity };
const ownerDeps = (): RecoveryOwnerDeps => ({ ...processDeps(), identity: () => identity,
  config: () => ({ devdUrl: record.devdUrl, sshHost: "devbox" }),
});

test("owner identity survives network retry with no SSH child, but not Mac reboot/PID reuse", () => {
  const deps = { ...ownerDeps(), processes: () => [] };
  expect(ownerAlive(identityRecord, deps)).toBe(true);
  expect(ownerAlive(identityRecord, { ...deps, identity: () => ({ ...identity, bootId: "darwin:200000:5678" }) })).toBe(false);
  expect(ownerAlive(identityRecord, { ...deps, identity: () => ({ ...identity, startedAt: "Fri Sep 11 12:35:57 2026" }) })).toBe(false);
  expect(ownerAlive(identityRecord, { ...deps, identity: () => undefined })).toBe(false);
});

test("even matching birth metadata requires the actual CLI in the same Warp pane", () => {
  const deps = ownerDeps();
  expect(ownerAlive(identityRecord, { ...deps, command: () => "/usr/bin/unrelated-daemon" })).toBe(false);
  expect(ownerAlive(identityRecord, { ...deps, warpEnvironment: () => ({ TERM_PROGRAM: "WarpTerminal", WARP_TERMINAL_SESSION_UUID: "b".repeat(32) }) })).toBe(false);
});

test("legacy records require exact live CLI/UUID/SSH host/container/tmux, never just live PID", () => {
  const old = { ...record, ownerPid: 10 };
  const deps = ownerDeps();
  expect(ownerAlive(old, deps)).toBe(true);
  expect(ownerAlive(old, { ...deps, command: () => "unrelated-process" })).toBe(false);
  expect(ownerAlive(old, { ...deps, config: () => ({ devdUrl: record.devdUrl, sshHost: "another-host" }) })).toBe(false);
  expect(ownerAlive({ ...old, tmuxSession: "main-4" }, deps)).toBe(false);
  expect(ownerAlive({ ...old, container: "another-container" }, deps)).toBe(false);
  expect(ownerAlive(old, { ...deps, processes: () => [] })).toBe(false);
});

test("migration saves birth identity for an old CLI and rejects PID changing mid-snapshot", () => {
  const cfg = { devdUrl: record.devdUrl, sshHost: "devbox" };
  const stable = { ...processDeps(), ownerIdentity: () => identity };
  const captured = snapshotWarpConnections([live], cfg, stable, 1000);
  expect(captured[0].ownerIdentity).toEqual(identity);
  expect(ownerAlive(captured[0], ownerDeps())).toBe(true);
  let reads = 0;
  const reused = { ...stable, ownerIdentity: () => (++reads === 1 ? identity : { ...identity, startedAt: "new-process" }) };
  expect(snapshotWarpConnectionPlan([live], cfg, reused, 1000).skipped).toBe(1);
});

test("first-update snapshot maps exact live dev/SSH process to saved Warp UUID without history", () => {
  const records = snapshotWarpConnections([live], { devdUrl: record.devdUrl, sshHost: "devbox" }, processDeps(), 1000);
  expect(records).toEqual([{ ...record, attachedAt: 1000, ownerPid: 10 }]);
});

test("snapshot skips other commands, missing/duplicate containers, non-Warp and appended commands", () => {
  expect(snapshotWarpConnections([live], { devdUrl: record.devdUrl, sshHost: "devbox" }, processDeps("ssh devbox echo hello"))).toEqual([]);
  expect(snapshotWarpConnections([], { devdUrl: record.devdUrl, sshHost: "devbox" }, processDeps())).toEqual([]);
  expect(snapshotWarpConnections([live, live], { devdUrl: record.devdUrl, sshHost: "devbox" }, processDeps())).toEqual([]);
  const nonWarp = { ...processDeps(), warpEnvironment: () => ({ TERM_PROGRAM: "other", WARP_TERMINAL_SESSION_UUID: pane }) };
  expect(snapshotWarpConnections([live], { devdUrl: record.devdUrl, sshHost: "devbox" }, nonWarp)).toEqual([]);
  expect(snapshotWarpConnections([live], { devdUrl: record.devdUrl, sshHost: "devbox" }, processDeps("ssh devbox docker exec -it dev-1 bash -lc 'tmux attach -d -t =main-3'; echo nope"))).toEqual([]);
});

test("snapshot rejects other SSH hosts and reports missing coverage", () => {
  const cfg = { devdUrl: record.devdUrl, sshHost: "different-server" };
  const plan = snapshotWarpConnectionPlan([live], cfg, processDeps());
  expect(plan.records).toEqual([]);
  expect(plan.warpCliProcesses).toBe(1);
  expect(plan.skipped).toBe(1);
});

test("snapshot rejects competing panes attached to the same exact tmux target", () => {
  const original = processDeps();
  const deps: SnapshotDeps = { ...original,
    processes: () => [...original.processes(), { pid: 20, ppid: 1, executable: "bun" }, { pid: 21, ppid: 20, executable: "ssh" }],
    command: (pid) => original.command(pid === 20 ? 10 : pid === 21 ? 11 : pid),
    warpEnvironment: (pid) => ({ TERM_PROGRAM: "WarpTerminal", WARP_TERMINAL_SESSION_UUID: pid === 20 ? "a".repeat(32) : pane }),
  };
  const plan = snapshotWarpConnectionPlan([live], { devdUrl: record.devdUrl, sshHost: "devbox" }, deps);
  expect(plan.warpCliProcesses).toBe(2);
  expect(plan.skipped).toBe(2);
  expect(plan.records).toEqual([]);
});

test("installer preserves shell config, targets both CLI paths, and is idempotent", () => {
  const home = temp(), repo = join(import.meta.dir, "..", "..");
  writeFileSync(join(home, ".zshrc"), "# existing customization\nexport KEEP_THIS=1\n");
  expect(installWarpRecovery(home, repo, process.execPath).length).toBeGreaterThan(0);
  const rc = readFileSync(join(home, ".zshrc"), "utf8");
  expect(rc).toContain("export KEEP_THIS=1");
  expect(rc.match(/# devbox-warp-recovery/g)).toHaveLength(1);
  expect(readlinkSync(join(home, ".bun", "bin", "dev"))).toBe(join(repo, "cli", "src", "main.ts"));
  expect(readlinkSync(join(home, ".local", "bin", "dev"))).toBe(join(repo, "cli", "src", "main.ts"));
  expect(installWarpRecovery(home, repo, process.execPath)).toEqual([]);
});
