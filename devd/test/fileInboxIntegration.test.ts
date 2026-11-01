// Cross-seam integration test: the real image/xclip shim (spawned as a subprocess)
// against a real devd `createApp` instance (via Bun.serve), with a fake Mac listener
// returning the file bytes. Verifies the whole chain shim → devd → disk — unlike the
// unit tests (xclipShim.test.ts, api.test.ts), which test the shim and the devd side
// in isolation and do not catch a bug at the seam between them (see previewIntegration.test.ts,
// where the same pattern revealed a bug in container→host port translation).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import { insertSession, openDb } from "../src/db";
import { createApp, type ApiDeps } from "../src/api";
import { CloneQueue } from "../src/clone";
import { SessionManager } from "../src/sessions";

const SHIM = join(import.meta.dir, "..", "..", "image", "xclip");

// async Bun.spawn — spawnSync would block the thread the Bun.serve stub runs on (deadlock)
async function runShim(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["sh", SHIM, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "ignore" });
  await p.exited;
  return Buffer.from(await new Response(p.stdout).arrayBuffer()).toString("utf8");
}

test("shim → devd → disk: ⌘V with a file stores it in .inbox and returns the container path", async () => {
  const root = mkdtempSync(join(tmpdir(), "seam-"));
  mkdirSync(join(root, "shop", "cms"), { recursive: true });
  const db = openDb(":memory:");
  insertSession(db, {
    id: "dev-shop-cms", folder: "shop", project: "shop", repo: "cms", container: "c",
    port_base: 4400, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
  });

  const listener: ApiDeps["listener"] = {
    open: async () => {}, notify: () => {}, openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
    clipboard: async (kind: string) =>
      kind === "targets"
        ? { status: 200, contentType: "text/plain", body: new TextEncoder().encode("application/x-devbox-file\ntext/plain\n") }
        : kind === "file"
        ? { status: 200, contentType: "application/octet-stream", filename: "data.bin", body: new Uint8Array([7, 8, 9]) }
        : { status: 204, contentType: null, body: new Uint8Array() },
  };

  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const cloneQueue = new CloneQueue({ db, root, tree: async () => [] });
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => {} };
  const backup = { build: async () => "/tmp/x", restore: async () => {} };

  const app = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [], listener,
    notify: () => {}, stats: () => ({ sessions: [], disk: { usedBytes: 0, totalBytes: 100 } }),
    cloneQueue, configRepo, backup,
  });
  const srv = Bun.serve({ port: 0, fetch: app.fetch });
  const env = { DEVD_URL: `http://localhost:${srv.port}`, DEVD_SESSION_ID: "dev-shop-cms" };
  try {
    const out = await runShim(["-t", "text/plain", "-o"], env);
    expect(out).toBe("/workspace/.inbox/data.bin");
    expect(existsSync(join(root, "shop", "cms", ".inbox", "data.bin"))).toBe(true);
    expect(readFileSync(join(root, "shop", "cms", ".inbox", "data.bin"))).toEqual(Buffer.from([7, 8, 9]));
  } finally {
    srv.stop(true);
  }
});
