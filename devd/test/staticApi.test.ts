import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ApiDeps } from "../src/api";
import { CloneQueue } from "../src/clone";
import { DEFAULT_CONFIG } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import { openDb } from "../src/db";
import { SessionManager } from "../src/sessions";

/** The full request path through static serving, not just StaticFiles — it was exactly in this wiring
 *  that `null` (no file) got turned into HTTP 200. */
function app() {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-static-api-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const listener = { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} };
  const cloneQueue = new CloneQueue({ db, root, tree: async () => [] });
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => {} };
  const dashboardDir = mkdtempSync(join(tmpdir(), "devd-static-api-dash-"));
  mkdirSync(join(dashboardDir, "assets"));
  writeFileSync(join(dashboardDir, "index.html"), "<html>HELLO</html>");
  writeFileSync(join(dashboardDir, "assets", "index-abc123.js"), "console.log('x');");
  const deps: ApiDeps = {
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [], listener, notify: () => {},
    stats: () => ({}), cloneQueue, configRepo, dashboardDir,
    backup: { build: async () => "/tmp/x", restore: async () => {} },
  };
  return createApp(deps);
}

// After a deploy an already open tab asks for a chunk with an old hash. While that
// got `200` with HTML (SPA fallback) or with the text "dashboard not built",
// the browser rejected it on the module MIME check and reported an incomprehensible error.
test("a missing chunk reaches the client as a 404", async () => {
  const r = await app().request("/assets/Subscriptions-STARYHASH.js");
  expect(r.status).toBe(404);
});

test("an existing chunk is still served as JavaScript", async () => {
  const r = await app().request("/assets/index-abc123.js");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("javascript");
});

test("a navigation path still gets index.html", async () => {
  const r = await app().request("/subscriptions");
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("HELLO");
});
