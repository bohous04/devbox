import { expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { createApp } from "../src/api";
import { CloneQueue } from "../src/clone";
import { SessionManager } from "../src/sessions";
import { AgentEventHub } from "../src/agentEvents";
import { insertSession, openDb, listEvents, type SessionRow } from "../src/db";
import { realSpawnPty } from "../src/pty";
import { sh } from "./helpers/sh";
import { hasDocker } from "./helpers/docker";

const hasImage = hasDocker && sh(process.cwd(), "docker", "images", "-q", "devbox:test").stdout.trim() !== "";

// Full path: a real WebSocket client → Bun.serve + upgradeWebSocket → Bridge
// (read-only + unlock) → realSpawnPty → in-container PTY → tmux. Also verifies audit events.
test.skipIf(!hasImage)("web terminal E2E: WS → unlock → echo comes back, audit in events", async () => {
  const ctr = "dev-e2e-app"; // = session id (container name)
  sh(process.cwd(), "docker", "rm", "-f", ctr);
  sh(process.cwd(), "docker", "run", "-d", "--name", ctr, "devbox:test", "sleep", "infinity");
  const db = openDb(":memory:");
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    sh(process.cwd(), "docker", "cp", `${import.meta.dir}/../../image/devbox-pty`, `${ctr}:/usr/local/bin/devbox-pty`);
    sh(process.cwd(), "docker", "exec", "-u", "0", ctr, "chmod", "+x", "/usr/local/bin/devbox-pty");
    sh(process.cwd(), "docker", "exec", "-u", "0", ctr, "sh", "-c", "printf '#!/bin/sh\\nexec bash\\n' > /usr/local/bin/claude-launch");

    const root = mkdtempSync(join(tmpdir(), "devd-e2e-"));
    const dashboardDir = mkdtempSync(join(tmpdir(), "devd-e2e-dash-"));
    writeFileSync(join(dashboardDir, "index.html"), "x");
    const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "devbox:test", extraMounts: [] });
    const app = createApp({
      mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [],
      listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} },
      notify: () => {}, stats: () => ({ sessions: [], disk: { usedBytes: 0, totalBytes: 1 } }),
      cloneQueue: new CloneQueue({ db, root, tree: async () => [] }),
      configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
      dashboardDir, backup: { build: async () => "/tmp/x", restore: async () => {} },
      agentEvents: new AgentEventHub({ db, notify: () => {} }),
      spawnPty: realSpawnPty,
    });
    insertSession(db, { id: ctr, folder: "acme", project: "e2e", repo: "app", container: ctr, port_base: 41500, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 } as SessionRow);

    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    const ws = new WebSocket(`ws://localhost:${server.port}/api/sessions/${ctr}/terminal`);
    let buf = "";
    const got = new Promise<boolean>((resolve) => {
      ws.onmessage = (e) => { buf += typeof e.data === "string" ? e.data : ""; if (buf.includes("WSMARK")) resolve(true); };
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: "r", cols: 100, rows: 30 }));
        ws.send(JSON.stringify({ t: "unlock" }));
        setTimeout(() => ws.send(JSON.stringify({ t: "i", d: "echo WSMARK\r" })), 1200);
      };
      setTimeout(() => resolve(false), 9000);
    });
    const ok = await got;
    ws.close();
    expect(ok).toBe(true);
    const types = listEvents(db).map((e) => e.type);
    expect(types).toContain("terminal_open");
    expect(types).toContain("terminal_control");
  } finally {
    server?.stop(true);
    sh(process.cwd(), "docker", "rm", "-f", ctr);
  }
}, 40_000);
