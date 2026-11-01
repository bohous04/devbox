// Cross-seam integration test: the real image/preview shim (spawned as a subprocess)
// against a real devd `createApp` instance (via Bun.serve). Verifies that the CONTAINER
// port the shim scans from /proc/net/tcp and sends as `containerPort` is correctly
// translated by devd to the HOST port (port_base + offset) and opens the right URL — unlike
// the unit tests, which test the container and devd sides in isolation
// and do not catch a mapping bug between them.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import { insertSession, openDb } from "../src/db";
import { createApp, type ApiDeps } from "../src/api";
import { CloneQueue } from "../src/clone";
import { SessionManager } from "../src/sessions";

const SHIM = join(import.meta.dir, "..", "..", "image", "preview");

// /proc/net/tcp fixture: a LISTEN (st=0A) socket on the given hex IP:port (same
// format as in previewShim.test.ts).
function procnet(rows: { ip: string; port: number }[]): string {
  const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const lines = rows.map((r, i) => {
    const hexPort = r.port.toString(16).toUpperCase().padStart(4, "0");
    return `   ${i}: ${r.ip}:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000 0 0 0 0 0`;
  });
  return head + lines.join("\n") + "\n";
}
const ANY = "00000000"; // 0.0.0.0

function writeProcnet(rows: { ip: string; port: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "preview-int-"));
  const f = join(dir, "procnet");
  writeFileSync(f, procnet(rows));
  return f;
}

test("cross-seam: shim (container port 3000) → devd → host port 40100", async () => {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-preview-int-"));
  insertSession(db, {
    id: "dev-x-web", folder: "x", project: "x", repo: "web", container: "dev-x-web",
    port_base: 40100, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0,
  });

  const captured: string[] = [];
  const listener: ApiDeps["listener"] = {
    open: async () => {},
    notify: () => {},
    clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }),
    openUrl: async (u) => { captured.push(u); }, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
  };

  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const cloneQueue = new CloneQueue({ db, root, tree: async () => [] });
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => {} };
  const backup = { build: async () => "/tmp/x", restore: async () => {} };

  const app = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [], listener,
    notify: () => {}, stats: () => ({ sessions: [], disk: { usedBytes: 0, totalBytes: 100 } }),
    cloneQueue, configRepo, backup, previewHost: "100.64.0.10",
  });

  const srv = Bun.serve({ port: 0, fetch: app.fetch });
  const fixture = writeProcnet([{ ip: ANY, port: 3000 }]);
  try {
    const p = Bun.spawn(["bun", SHIM, "3000"], {
      env: { ...process.env, DEVD_SESSION_ID: "dev-x-web", DEVD_URL: `http://127.0.0.1:${srv.port}`, PREVIEW_PROCNET: fixture },
      stdout: "pipe", stderr: "pipe",
    });
    const code = await p.exited;
    expect(code).toBe(0);
    expect(captured[0]).toBe("http://100.64.0.10:40100");
  } finally {
    srv.stop(true);
  }
});
