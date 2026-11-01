import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwitchAccountResult } from "../../devd/src/accountSwitch";
import { createApp } from "../../devd/src/api";
import { CloneQueue } from "../../devd/src/clone";
import { DEFAULT_CONFIG, resolveAccountPool } from "../../devd/src/config";
import { insertSession, openDb, type SessionRow } from "../../devd/src/db";
import { SessionManager } from "../../devd/src/sessions";

// `dev switch` end-to-end: real devd (createApp) behind a real HTTP server, real
// CLI binary spawned as a subprocess (matches main-e2e.test.ts's convention) — a
// stubbed `switchAccount` stands in for accountSwitch.ts's own logic (that logic
// has its own exhaustive tests in accountSwitch.test.ts with a fake docker exec).
// This file exists specifically to catch what a unit test of the CLI's dispatch
// alone would miss: the whole round trip through ApiClient, plus the CLI-side
// guards that run BEFORE any request is sent (C1's Codex guard).

const db = openDb(":memory:");
const root = mkdtempSync(join(tmpdir(), "cli-switch-"));
const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], controlRoot: join(root, "ctl") });
const cloneQueue = new CloneQueue({ db, root, tree: async () => [] });

const CLAUDE_ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude",
};
const CODEX_ROW: SessionRow = {
  id: "dev-shop-bot", folder: "acme", project: "shop", repo: "bot", container: "dev-shop-bot",
  port_base: 40110, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "codex",
};
const STOPPED_ROW: SessionRow = {
  id: "dev-shop-old", folder: "acme", project: "shop", repo: "old", container: "dev-shop-old",
  port_base: 40120, status: "stopped", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude",
};
insertSession(db, CLAUDE_ROW);
insertSession(db, CODEX_ROW);
insertSession(db, STOPPED_ROW);

function makeServer(switchAccount: (id: string) => Promise<SwitchAccountResult>) {
  const calls: string[] = [];
  const app = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [],
    listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} },
    notify: () => {}, stats: () => ({}), cloneQueue,
    configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    accounts: {
      profiles: {} as never, leaseMaxAgeMs: () => 4 * 3600_000,
      settings: () => resolveAccountPool(DEFAULT_CONFIG.settings),
      switchAccount: (id) => { calls.push(id); return switchAccount(id); },
      refresh: async () => {},
    },
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return { server, calls };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => { for (const s of servers) s.stop(true); });

async function runCli(port: number | undefined, ...args: string[]) {
  const p = Bun.spawn(["bun", "cli/src/main.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, DEV_DEVD_URL: `http://127.0.0.1:${port}`, DEV_SSH_HOST: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { code, out: stdout + stderr };
}

// C1 (review round 1, critical): `/exit` into Codex would throw away its turn and bring the
// pane back as Claude on someone else's profile — the pool does not apply to Codex at all, so
// the CLI must refuse BEFORE any devd call (no chance for the request to race with devd's
// own defense from accountSwitchApi.test.ts).
test("dev switch on a Codex session refuses without a single devd call (C1)", async () => {
  const { server, calls } = makeServer(async () => ({ status: "switched", accountId: "backup", label: "backup@x.cz", exhausted: false, panes: [] }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "shop/bot");
  expect(r.code).toBe(1);
  expect(r.out).toContain("Codex");
  expect(calls.length).toBe(0);
});

test("dev switch on a stopped session refuses without calling devd", async () => {
  const { server, calls } = makeServer(async () => ({ status: "switched", accountId: "backup", label: "backup@x.cz", exhausted: false, panes: [] }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "shop/old");
  expect(r.code).toBe(1);
  expect(r.out).toContain("isn't running");
  expect(calls.length).toBe(0);
});

test("dev switch on an unknown target refuses without calling devd", async () => {
  const { server, calls } = makeServer(async () => ({ status: "switched", accountId: "backup", label: "backup@x.cz", exhausted: false, panes: [] }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "missing/nowhere");
  expect(r.code).toBe(1);
  expect(r.out).toContain("doesn't exist");
  expect(calls.length).toBe(0);
});

// I5 (review round 1, important): devd decides the session is already on this account
// (unchanged) — the CLI must admit it as a no-op, not present it as a successful switch.
test("dev switch where devd returns unchanged → 'nothing to do', no switch celebration (I5)", async () => {
  const { server } = makeServer(async () => ({ status: "unchanged", accountId: "backup", label: "backup@x.cz" }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "shop/cms");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Already on backup@x.cz");
  expect(r.out).toContain("nothing to do");
  expect(r.out).not.toContain("Switched");
});

test("dev switch with no usable account → error, no claim of success", async () => {
  const { server } = makeServer(async () => ({ status: "no-account" }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "shop/cms");
  expect(r.code).toBe(1);
  expect(r.out).toContain("no usable Anthropic account");
});

test("dev switch where no pane could be restarted → error with pane details", async () => {
  const { server } = makeServer(async () => ({
    status: "failed", accountId: "backup", label: "backup@x.cz", exhausted: false,
    panes: [{ target: "main:0.0", outcome: "did-not-exit" }],
  }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "shop/cms");
  expect(r.code).toBe(1);
  expect(r.out).toContain("couldn't restart");
  expect(r.out).toContain("main:0.0=did-not-exit");
});

test("dev switch succeeded but one pane got stuck → 0, reports success and a stuck-pane warning", async () => {
  const { server } = makeServer(async () => ({
    status: "switched", accountId: "backup", label: "backup@x.cz", exhausted: false,
    panes: [{ target: "main:0.0", outcome: "restarted" }, { target: "main-3:0.0", outcome: "did-not-return" }],
  }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "shop/cms");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Switched shop/cms to backup@x.cz");
  expect(r.out).toContain("still on the old account");
  expect(r.out).toContain("main-3:0.0 (did-not-return)");
});

// Fix: a pane that devd found ALREADY on the target profile (outcome
// "already-on-account", see accountSwitch.ts) was skipped unchanged — that is NOT a
// failure nor "stuck on the old account", and the CLI must not present it that way.
test("dev switch where a pane was ALREADY on the target account (already-on-account) → no stuck warning", async () => {
  const { server } = makeServer(async () => ({
    status: "switched", accountId: "backup", label: "backup@x.cz", exhausted: false,
    panes: [{ target: "main:0.0", outcome: "already-on-account" }, { target: "main-3:0.0", outcome: "restarted" }],
  }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "shop/cms");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Switched shop/cms to backup@x.cz");
  expect(r.out).not.toContain("still on the old account");
});

test("dev switch fully clean success → 0, no warning", async () => {
  const { server } = makeServer(async () => ({
    status: "switched", accountId: "backup", label: "backup@x.cz", exhausted: false,
    panes: [{ target: "main:0.0", outcome: "restarted" }],
  }));
  servers.push(server);
  const r = await runCli(server.port, "switch", "shop/cms");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Switched shop/cms to backup@x.cz");
  expect(r.out).not.toContain("still on the old account");
  // The hint carries the ID, not `project/repo`: that query can match several sessions of the
  // same repo and `dev attach` would ask about it (or fail in automation). See matchSessions.
  expect(r.out).toContain("dev attach dev-shop-cms");
});

test("dev switch without a target → usage (2)", async () => {
  const { server } = makeServer(async () => ({ status: "no-account" }));
  servers.push(server);
  const r = await runCli(server.port, "switch");
  expect(r.code).toBe(2);
});
