// /api/auth/claude/login/* — Claude sign-in from the dashboard. Operator addresses only: a session
// container must not be able to replace the claude-home credentials every session shares.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import { openDb } from "../src/db";
import { createApp, type ApiDeps } from "../src/api";
import { CloneQueue } from "../src/clone";
import { SessionManager } from "../src/sessions";
import type { CodexAuthDeps } from "../src/agentAuth";

const URL_PANE = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s\nPaste code here if prompted >";

function setup(addr: string) {
  const root = mkdtempSync(join(tmpdir(), "devd-claude-login-"));
  const db = openDb(":memory:");
  const calls: { cmd: string[]; input?: string }[] = [];
  const codexAuth: CodexAuthDeps = {
    run: async (cmd, input) => {
      calls.push({ cmd, input });
      const s = cmd.join(" ");
      if (cmd[0] === "run") return { code: 0, stdout: "cid", stderr: "" };   // its sh -c mentions the exit marker too
      if (s.includes("capture-pane")) return { code: 0, stdout: URL_PANE, stderr: "" };
      if (s.includes("devbox-claude-login.exit")) return { code: 1, stdout: "", stderr: "" };
      if (s.startsWith("inspect")) return { code: 0, stdout: "running", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    sleep: async () => {},
  };
  const listener: ApiDeps["listener"] = {
    open: async () => {}, notify: () => {}, openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {},
    clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }),
  };
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"] });
  const configRepo: ConfigRepo = { read: () => DEFAULT_CONFIG, write: async () => {} };
  const a = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, tree: async () => [], listener,
    notify: () => {}, stats: () => ({ sessions: [], disk: { usedBytes: 0, totalBytes: 100 } }),
    cloneQueue: new CloneQueue({ db, root, tree: async () => [] }), configRepo,
    backup: { build: async () => "/tmp/x", restore: async () => {} },
    remoteAddr: () => addr, codexAuth,
  });
  return { a, calls };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("operator: start returns the URL, code goes to the container, status is reported", async () => {
  const { a, calls } = setup("100.64.0.7");
  const start = await a.request("/api/auth/claude/login/start", post({}));
  expect(start.status).toBe(200);
  expect(((await start.json()) as { url: string }).url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=s");
  const code = await a.request("/api/auth/claude/login/code", post({ code: "abc#s" }));
  expect(code.status).toBe(204);
  expect(calls.find((c) => c.cmd[0] === "exec" && c.cmd[1] === "-i")?.input).toBe("abc#s");
  const status = await a.request("/api/auth/claude/login/status");
  expect(await status.json()).toEqual({ status: "pending" });
});

test("operator: an invalid code is a 400 and never reaches docker", async () => {
  const { a, calls } = setup("127.0.0.1");
  const r = await a.request("/api/auth/claude/login/code", post({ code: "bad code" }));
  expect(r.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test("a session container cannot start, finish or poll a Claude login", async () => {
  const { a, calls } = setup("172.18.0.5");
  expect((await a.request("/api/auth/claude/login/start", post({}))).status).toBe(403);
  expect((await a.request("/api/auth/claude/login/code", post({ code: "abc" }))).status).toBe(403);
  expect((await a.request("/api/auth/claude/login/status")).status).toBe(403);
  expect(calls).toHaveLength(0);
});
