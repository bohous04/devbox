import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ApiDeps } from "../src/api";
import { CloneQueue } from "../src/clone";
import { DEFAULT_CONFIG } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import { openDb } from "../src/db";
import { SessionManager } from "../src/sessions";
import type { CodexView } from "../src/codexPoller";

function app(view: CodexView | null | undefined) {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-subs-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const listener = { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} };
  const cloneQueue = new CloneQueue({ db, root, tree: async () => [] });
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => {} };
  const dashboardDir = mkdtempSync(join(tmpdir(), "devd-dash-"));
  writeFileSync(join(dashboardDir, "index.html"), "HELLO");
  const deps: ApiDeps = {
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [], listener, notify: () => {},
    stats: () => ({}), cloneQueue, configRepo, dashboardDir,
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    codexUsage: view === undefined ? undefined : { view: () => view },
  };
  return createApp(deps);
}

const view: CodexView = {
  state: "ok", planType: "plus",
  windows: [{ kind: "primary", usedPct: 42, windowMinutes: 300, resetsAt: 1_787_242_200_000 }],
  credits: null, limitReached: null, fetchedAt: 1_787_224_361_140, error: null,
};

test("GET /api/subscriptions/codex: returns the latest measurement", async () => {
  const r = await app(view).request("/api/subscriptions/codex");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ codex: view });
});

// A devbox without Codex is not an error — the section is simply not rendered.
test("GET /api/subscriptions/codex: without poller deps and without measurements returns codex: null", async () => {
  expect(await (await app(undefined).request("/api/subscriptions/codex")).json()).toEqual({ codex: null });
  expect(await (await app(null).request("/api/subscriptions/codex")).json()).toEqual({ codex: null });
});
