import { afterEach, expect, spyOn, test } from "bun:test";
import * as remote from "../../infra/codex-remote/restoreSession";
import * as canonical from "../src/canonicalWorkspace";
import { createApp } from "../src/api";
import { CodexSessionAccounts } from "../src/codexSessionAccounts";
import { beginCodexRemoteLaunch, codexRemoteLaunchScope } from "../src/codexRemoteLaunch";
import { DEFAULT_CONFIG } from "../src/config";
import { deleteSession, getSession, insertSession, listEvents, openDb, updateSession, type SessionRow } from "../src/db";
import { SessionManager } from "../src/sessions";

const ID = "dev-games-pdm";
const THREAD = "11111111-2222-4333-8444-000000000001";
const EXTRA = "84102735-cebc-42bc-bd8b-6a9f75e4b9ce";
const CWD = `/tmp/devd-codex-launch/_sessions/${ID}`;
const ROUTE: remote.RemoteRoute = { container: ID, environment_id: `devbox_${ID}`, cwd: CWD, thread_ids: [THREAD],
  restore: { folder: "dev", project: "games", repo: "pdm", solo: 0, worktree: CWD, bare: "/tmp/devd-codex-launch/dev/games/pdm.git", branch: "session/pdm" } };
const ROW: SessionRow = { id: ID, container: ID, folder: "dev", project: "games", repo: "pdm", worktree: CWD,
  solo: 0, status: "running", agent: "codex", port_base: 40100, created_at: 1, last_active_at: 2, important: 0 };
const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
const post = (body?: unknown) => ({ method: "POST", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });

function fixture() {
  // createApp retains an unref operation poller; as in the other API fixtures,
  // its in-memory database shares the application's process lifetime.
  const db = openDb(":memory:"); insertSession(db, ROW);
  const inFlight = new Set<string>();
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root: "/tmp/devd-codex-launch", image: "unused", inFlight });
  let observed: remote.ObservedContainer = { state: "running", workspace: CWD, canonicalMount: true, containerId: "a".repeat(64) };
  const route = spyOn(remote, "loadRemoteRoute").mockImplementation(id => {
    if (id !== ID) throw new remote.RemoteRestoreError("No retained Remote route", 404);
    return structuredClone(ROUTE);
  });
  const inspect = spyOn(canonical, "inspectCanonicalWorkspace").mockImplementation(async () => observed);
  restores.push(() => route.mockRestore(), () => inspect.mockRestore());
  let pending: string | undefined = JSON.stringify({ version: 1, sourceAccountId: EXTRA, targetAccountId: "default", threadId: THREAD, cwd: "/workspace", phase: "resume" });
  let alive = false;
  let duringLaunch: (() => Promise<void>) | undefined;
  let duringVerify: (() => Promise<void>) | undefined;
  let duringClear: (() => Promise<void>) | undefined;
  const callbacks: { endpoint: string; status: number }[] = [];
  const commands: string[][] = [];
  const exec = async (_container: string, command: string[]) => {
    commands.push(command);
    if (command[0] === "tmux" && command[1] === "list-panes") return ok(`main:0.0\t100${command.at(-1)!.includes("@devd_codex_continuation") ? `\t${pending ?? ""}` : ""}`);
    if (command[0] === "tmux" && command[1] === "set-option") {
      if (command.includes("-u")) await duringClear?.();
      pending = command.includes("-u") ? undefined : command.at(-1); return ok();
    }
    if (command[0] === "ps") return ok(`100 1 1 zsh\n${alive ? "501 100 1 codex\n" : ""}`);
    if (command[0] === "python3") {
      if (command[2]!.includes("CODEX_SESSION_ACCOUNT_PREFLIGHT")) return ok('{"default":null}');
      if (command[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE")) return ok(JSON.stringify({ CODEX_HOME: "/home/dev/.codex", HOME: "/home/dev", resumeThreadId: THREAD }));
      if (command[3] === "grant-full-access") return ok(JSON.stringify({ ok: true, threadId: THREAD }));
      if (command[3] === "verify") { await duringVerify?.(); return ok(JSON.stringify({ ok: true, threadId: THREAD })); }
      if (command[3] === "begin") return ok('{"capture":"/tmp/devd-codex-continuation-test"}');
      if (command[3] === "peek-status") return ok(JSON.stringify({ threadId: THREAD }));
      return ok('{"ok":true}');
    }
    if (command[1] === "send-keys" && command[4]?.includes("/usr/local/bin/co")) {
      await duringLaunch?.();
      // Real Remote dispatcher performs BOTH nested lifecycle requests before
      // the native client can attach. Keep the actual Hono + manager path here.
      for (const endpoint of ["resume-remote", "externally-started"]) {
        const response = await app.request(`/api/sessions/${ID}/${endpoint}`, post());
        callbacks.push({ endpoint, status: response.status });
        if (response.status !== 200) return { ...ok(), code: 1 };
        const result = await response.json() as { session: SessionRow; cwd?: string };
        expect(result.session).toMatchObject(ROW);
        if (endpoint === "resume-remote") expect(result.cwd).toBe(CWD);
      }
      alive = true;
    }
    return ok();
  };
  const service = new CodexSessionAccounts({ db, inFlight, exec, now: () => 123, sleep: async () => {},
    accounts: { list: () => ({ accounts: [{ id: "default", label: "Main", isDefault: true, disabled: false, usage: null, sharedUsageWith: [] }], preferredAccountId: null }) } });
  const app = createApp({ mgr, db, cfg: DEFAULT_CONFIG, root: "/tmp/devd-codex-launch", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}), cloneQueue: {} as never, configRepo: {} as never,
    dashboardDir: "/tmp", backup: { build: async () => "/tmp/x", restore: async () => {} }, codexSessionAccounts: service });
  return { app, service, db, inFlight, callbacks, commands, inspect, route,
    setObserved: (value: remote.ObservedContainer) => { observed = value; },
    duringLaunch: (callback: () => Promise<void>) => { duringLaunch = callback; },
    duringVerify: (callback: () => Promise<void>) => { duringVerify = callback; },
    duringClear: (callback: () => Promise<void>) => { duringClear = callback; } };
}

test("default account recovery permits both read-only Remote callbacks while concurrent stop and switch remain locked", async () => {
  const f = fixture();
  f.duringLaunch(async () => {
    expect(f.inFlight.has(ID)).toBe(true);
    expect((await f.app.request(`/api/sessions/${ID}/stop`, post())).status).toBe(409);
    expect((await f.app.request(`/api/sessions/${ID}/codex-account`, post({ accountId: "default" }))).status).toBe(409);
  });
  const response = await f.app.request(`/api/sessions/${ID}/codex-account`, post({ accountId: "default" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, panes: [{ outcome: "restarted", threadId: THREAD }] });
  expect(f.callbacks).toEqual([{ endpoint: "resume-remote", status: 200 }, { endpoint: "externally-started", status: 200 }]);
  expect(getSession(f.db, ID)).toMatchObject(ROW);
  expect(listEvents(f.db).map(event => event.type)).toEqual(["codex_account_switch"]);
  expect(f.inFlight.has(ID)).toBe(false);
  expect(codexRemoteLaunchScope(f.inFlight, ID)).toBeUndefined();
});

test("Remote callbacks remain read-only through final verification and pending cleanup", async () => {
  const f = fixture();
  const before = getSession(f.db, ID);
  const statuses: number[] = [];
  const confirm = async () => {
    statuses.push((await f.app.request(`/api/sessions/${ID}/resume-remote`, post())).status);
    statuses.push((await f.app.request(`/api/sessions/${ID}/externally-started`, post())).status);
  };
  f.duringVerify(confirm);
  f.duringClear(confirm);
  expect((await f.service.switch(ID, "default")).ok).toBe(true);
  expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  expect(getSession(f.db, ID)).toEqual(before);
  expect(listEvents(f.db).map(event => event.type)).toEqual(["codex_account_switch"]);
});

for (const scenario of ["missing-row", "stopped-row", "missing-container", "stopped-container", "wrong-workspace", "symlink-source-alias", "missing-canonical-mount"] as const) {
  test(`scoped Remote callbacks refuse ${scenario} without lifecycle mutation`, async () => {
    const f = fixture();
    const statuses: number[] = [];
    f.duringLaunch(async () => {
      if (scenario === "missing-row") deleteSession(f.db, ID);
      else if (scenario === "stopped-row") updateSession(f.db, ID, { status: "stopped" });
      else f.setObserved({ state: scenario === "missing-container" ? "missing" : scenario === "stopped-container" ? "stopped" : "running",
        workspace: scenario === "wrong-workspace" ? "/tmp/other-workspace" : scenario === "symlink-source-alias" ? "/tmp/workspace-alias" : CWD,
        canonicalMount: scenario !== "missing-canonical-mount", containerId: "a".repeat(64) });
      for (const endpoint of ["resume-remote", "externally-started"]) statuses.push((await f.app.request(`/api/sessions/${ID}/${endpoint}`, post())).status);
    });
    expect((await f.service.switch(ID, "default")).ok).toBe(false);
    expect(statuses).toEqual([409, 409]);
    expect(getSession(f.db, ID)?.status).toBe(scenario === "missing-row" ? undefined : scenario === "stopped-row" ? "stopped" : "running");
    expect(f.commands.some(command => command[1] === "set-environment")).toBe(false);
    expect(listEvents(f.db).every(event => event.type === "codex_account_switch")).toBe(true);
    expect(f.inFlight.has(ID)).toBe(false);
    expect(codexRemoteLaunchScope(f.inFlight, ID)).toBeUndefined();
  });
}

test("ordinary lifecycle locks, another session and a completed launch cannot use the internal scope", async () => {
  const f = fixture();
  f.inFlight.add(ID);
  for (const endpoint of ["resume-remote", "externally-started"]) expect((await f.app.request(`/api/sessions/${ID}/${endpoint}`, post())).status).toBe(409);
  expect(f.inspect).not.toHaveBeenCalled();
  f.inFlight.delete(ID);
  const otherStatuses: number[] = [];
  f.duringLaunch(async () => {
    for (const endpoint of ["resume-remote", "externally-started"]) otherStatuses.push((await f.app.request(`/api/sessions/dev-unknown/${endpoint}`, post())).status);
  });
  expect((await f.service.switch(ID, "default")).ok).toBe(true);
  expect(otherStatuses.every(status => status !== 200)).toBe(true);
  f.inFlight.add(ID);
  for (const endpoint of ["resume-remote", "externally-started"]) expect((await f.app.request(`/api/sessions/${ID}/${endpoint}`, post())).status).toBe(409);
});

test("a failed launch removes the scope before releasing its lifecycle lock", async () => {
  const f = fixture();
  f.duringLaunch(async () => { throw new Error("native launch failed"); });
  expect((await f.service.switch(ID, "default")).ok).toBe(false);
  expect(f.inFlight.has(ID)).toBe(false);
  f.inFlight.add(ID);
  for (const endpoint of ["resume-remote", "externally-started"]) expect((await f.app.request(`/api/sessions/${ID}/${endpoint}`, post())).status).toBe(409);
  expect(codexRemoteLaunchScope(f.inFlight, ID)).toBeUndefined();
});

test("a revoked scope cannot be replaced during an awaited workspace inspection", async () => {
  const f = fixture();
  f.inFlight.add(ID);
  const finish = beginCodexRemoteLaunch(f.inFlight, ID);
  let inspected!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { inspected = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  f.inspect.mockImplementation(async () => { inspected(); await paused; return { state: "running", workspace: CWD, canonicalMount: true }; });
  const response = f.app.request(`/api/sessions/${ID}/resume-remote`, post());
  await entered;
  finish();
  const finishReplacement = beginCodexRemoteLaunch(f.inFlight, ID);
  resume();
  expect((await response).status).toBe(409);
  expect(getSession(f.db, ID)).toMatchObject(ROW);
  expect(listEvents(f.db)).toEqual([]);
  finishReplacement();
});
