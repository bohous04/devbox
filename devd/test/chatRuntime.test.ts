import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { chatRuntimeBlock } from "../src/agents";
import { DEFAULT_CONFIG } from "../src/config";
import { getRepoAgent, getSession, insertSession, openDb, setRepoAgent, type SessionRow } from "../src/db";
import { runArgs } from "../src/docker";
import { SessionManager } from "../src/sessions";

test("openDb adds sessions.runtime with default tmux to an existing DB", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-mig-"));
  const path = join(dir, "devd.db");
  const old = new Database(path);
  old.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, folder TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
    container TEXT NOT NULL, port_base INTEGER NOT NULL UNIQUE, status TEXT NOT NULL,
    solo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL)`);
  old.run(`INSERT INTO sessions VALUES ('dev-a-b','f','a','b','dev-a-b',40100,'running',0,1,1)`);
  old.close();
  const db = openDb(path);
  expect(getSession(db, "dev-a-b")!.runtime).toBe("tmux");
});

test("insertSession stores the runtime", () => {
  const db = openDb(":memory:");
  const row: SessionRow = { id: "dev-a-b", folder: "f", project: "a", repo: "b", container: "dev-a-b", port_base: 40100,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat" };
  insertSession(db, row);
  expect(getSession(db, "dev-a-b")!.runtime).toBe("chat");
});

test("chatRuntimeBlock: vps claude/codex and proxy profiles allowed, instabox and other agents blocked", () => {
  expect(chatRuntimeBlock("claude", "vps")).toBeNull();
  expect(chatRuntimeBlock("codex", "vps")).toBeNull();
  expect(chatRuntimeBlock("claude", "instabox")).toBe("Chat sessions run only on the VPS");
  for (const proxy of ["claude-gemini", "claude-openrouter"] as const) expect(chatRuntimeBlock(proxy, "vps")).toBeNull();
  expect(chatRuntimeBlock("grok", "vps")).toBe("Grok Build is not available in chat sessions yet");
  expect(chatRuntimeBlock("antigravity", "vps")).toContain("is not available in chat sessions yet");
});

function appWith(open: (t: Record<string, unknown>) => Promise<unknown>) {
  return createApp({
    mgr: { open } as never, db: openDb(":memory:"), cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} },
  } as never);
}
const post = (a: ReturnType<typeof appWith>, body: unknown) =>
  a.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const BASE = { folder: "f", project: "p", repo: "r" };

test("POST /api/sessions runtime=chat agent=claude → 201 and mgr.open gets runtime", async () => {
  const seen: Record<string, unknown>[] = [];
  const a = appWith(async (t) => { seen.push(t); return { created: true, session: { id: "dev-p-r", status: "running", runtime: "chat" } }; });
  const r = await post(a, { ...BASE, runtime: "chat", agent: "claude" });
  expect(r.status).toBe(201);
  expect(seen[0]!.runtime).toBe("chat");
});

test("POST /api/sessions without runtime passes none (tmux default)", async () => {
  const seen: Record<string, unknown>[] = [];
  const a = appWith(async (t) => { seen.push(t); return { created: true, session: { id: "dev-p-r", status: "running", runtime: "tmux" } }; });
  expect((await post(a, BASE)).status).toBe(201);
  expect(seen[0]!.runtime).toBeUndefined();
});

test("POST /api/sessions chat with a non-chat agent, on instabox, with solo or bogus runtime → 400", async () => {
  let calls = 0;
  const a = appWith(async () => { calls++; return { created: true }; });
  const grok = await post(a, { ...BASE, runtime: "chat", agent: "grok" });
  expect(grok.status).toBe(400);
  expect((await grok.json() as { error: string }).error).toBe("Grok Build is not available in chat sessions yet");
  const ibx = await post(a, { ...BASE, cloneUrl: "https://git.example/x.git", runtime: "chat", host: "instabox" });
  expect(ibx.status).toBe(400);
  expect((await ibx.json() as { error: string }).error).toBe("Chat sessions run only on the VPS");
  expect((await post(a, { ...BASE, runtime: "chat", solo: true })).status).toBe(400);
  expect((await post(a, { ...BASE, runtime: "bogus" })).status).toBe(400);
  expect(calls).toBe(0);
});

test("a chat session's container env carries DEVD_RUNTIME=chat (tmux row: tmux)", async () => {
  const db = openDb(":memory:");
  const mgr = new SessionManager({
    db, cfg: structuredClone(DEFAULT_CONFIG), root: mkdtempSync(join(tmpdir(), "rt-root-")), image: "devbox:latest",
    controlRoot: mkdtempSync(join(tmpdir(), "rt-ctl-")), extraMounts: [],
  });
  const mk = (id: string, runtime: "tmux" | "chat", port: number) => insertSession(db, {
    id, folder: "f", project: "p", repo: id, container: id, port_base: port, status: "running", solo: 0,
    created_at: 0, last_active_at: 0, important: 0, runtime });
  mk("dev-p-chat", "chat", 40100); mk("dev-p-tmux", "tmux", 40200);
  // runOpts is private; element access keeps the test type-checked against its real signature.
  const args = async (id: string, repo: string, runtime: "tmux" | "chat") => runArgs(await mgr["runOpts"](id, "/srv/dev/p/r", 40100, "p", repo, "claude", runtime));
  expect(await args("dev-p-chat", "chat", "chat")).toContain("DEVD_RUNTIME=chat");
  expect(await args("dev-p-tmux", "tmux", "tmux")).toContain("DEVD_RUNTIME=tmux");
});

function chatSession(db: ReturnType<typeof openDb>, agent: "claude" | "codex" = "claude") {
  insertSession(db, { id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent, runtime: "chat" });
}
function appOn(db: ReturnType<typeof openDb>, open: () => Promise<unknown>) {
  return createApp({
    mgr: { open } as never, db, cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} },
  } as never);
}

test("reopening a chat session by sessionId with a non-chat agent (given or remembered) → 400, mgr.open not called", async () => {
  let calls = 0;
  const db = openDb(":memory:");
  chatSession(db);
  const a = appOn(db, async () => { calls++; return { created: false }; });
  const given = await post(a, { ...BASE, sessionId: "dev-p-r", agent: "grok" });
  expect(given.status).toBe(400);
  expect((await given.json() as { error: string }).error).toBe("Grok Build is not available in chat sessions yet");
  setRepoAgent(db, "f", "p", "r", "antigravity", 1);
  const remembered = await post(a, { ...BASE, sessionId: "dev-p-r" });
  expect(remembered.status).toBe(400);
  expect(calls).toBe(0);
});

test("SessionManager.open refuses an agent chat cannot run on a stored chat session, before any agent write", async () => {
  const db = openDb(":memory:");
  chatSession(db);
  const mgr = new SessionManager({
    db, cfg: structuredClone(DEFAULT_CONFIG), root: mkdtempSync(join(tmpdir(), "rt-root-")), image: "devbox:latest",
    controlRoot: mkdtempSync(join(tmpdir(), "rt-ctl-")), extraMounts: [],
  });
  await expect(mgr.open({ folder: "f", project: "p", repo: "r", agent: "grok", sessionId: "dev-p-r", runtime: "chat" }))
    .rejects.toThrow("Grok Build is not available in chat sessions yet");
  expect(getSession(db, "dev-p-r")!.agent).toBe("claude");
  expect(getRepoAgent(db, "f", "p", "r")).toBeNull();
});

test("a pull conflict is written to the prompt file for tmux only; chat gets it back to send as a message", () => {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "rt-prompt-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", controlRoot: join(root, "ctl") });
  const sync = (mgr as unknown as { syncPromptFile: (id: string, runtime: string, pull: unknown, override?: string) => string | undefined }).syncPromptFile.bind(mgr);
  const conflict = { status: "conflict", files: ["a.ts"] };
  const file = (id: string) => join(root, "ctl", id, "prompt");

  const tmux = sync("dev-a-tmux", "tmux", conflict);
  expect(tmux).toContain("a.ts");
  expect(readFileSync(file("dev-a-tmux"), "utf8")).toBe(tmux!);

  // A stale prompt file from an earlier tmux life of the id is cleared, never left for agent-launch.
  mkdirSync(join(root, "ctl", "dev-a-chat"), { recursive: true });
  writeFileSync(file("dev-a-chat"), "stale");
  const chat = sync("dev-a-chat", "chat", conflict);
  expect(chat).toBe(tmux);
  expect(existsSync(file("dev-a-chat"))).toBe(false);
  expect(sync("dev-a-chat", "chat", { status: "ok" })).toBeUndefined();
});
