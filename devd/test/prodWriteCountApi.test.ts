import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import { insertSession, insertMetrics, openDb, listSchedules, listNotifyLog, logEvent, getSession, setRepoAgent, type SessionRow } from "../src/db";
import { createApp } from "../src/api";
import { sh } from "./helpers/sh";
import { loadCatalog } from "../src/prodDb";
import { createDbTargets } from "../src/dbTargets";
import { CloneQueue } from "../src/clone";
import { SessionBusyError, SessionManager } from "../src/sessions";
import { AgentEventHub, type NotifyExtra } from "../src/agentEvents";
import { GiteaAuthError, GiteaError, GiteaUnknownInstanceError } from "../src/gitea";

import type { ApiDeps } from "../src/api";
import { terminalGuard } from "../src/terminal";

function app(github?: ApiDeps["github"], gitea?: ApiDeps["gitea"], listenerOverride?: ApiDeps["listener"], extra?: Partial<ApiDeps>) {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-api-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const opened: string[] = [];
  const listener = listenerOverride ?? { open: async (p: string) => { opened.push(p); }, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} };
  const stats = () => ({ sessions: [], disk: { usedBytes: 0, totalBytes: 100 } });
  const cloneQueue = new CloneQueue({ db, root, tree: async () => [] });
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => {} };
  const dashboardDir = mkdtempSync(join(tmpdir(), "devd-dashboard-"));
  writeFileSync(join(dashboardDir, "index.html"), "HELLO");
  const backup = { build: async () => "/tmp/x", restore: async () => {} };
  const notified: { title: string; message: string; extra?: NotifyExtra }[] = [];
  const agentEvents = new AgentEventHub({
    db, notify: (title, message, extra) => { notified.push({ title, message, extra }); },
    quietMs: 0, coalesceMs: 0,
  });
  const a = createApp({ mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [], listener, notify: () => {}, stats, cloneQueue, configRepo, dashboardDir, backup, github, gitea, agentEvents, scheduler: { fireNow: async () => true }, ...extra });
  return { a, db, root, opened, notified, agentEvents };
}

test("production write count includes all waiting states beyond list pagination", async () => {
  const { a, db } = app(undefined, undefined, undefined, { remoteAddr: () => "127.0.0.1" });
  const insert = db.query("INSERT INTO prod_writes(ts,session_id,db,sql,status) VALUES(?,?,?,?,?)");
  for (let i = 0; i < 130; i++) insert.run(i, null, "test", "SELECT 1", ["blocked", "pending", "approved"][i % 3]);
  insert.run(999, null, "test", "SELECT 1", "executed");
  const response = await a.request("/api/prod-db/write-count");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ count: 130 });
  db.close();
});

test("production write count does not disclose totals to an untrusted caller", async () => {
  const { a, db } = app(undefined, undefined, undefined, { remoteAddr: () => "203.0.113.10" });
  expect((await a.request("/api/prod-db/write-count")).status).toBe(403);
  db.close();
});
