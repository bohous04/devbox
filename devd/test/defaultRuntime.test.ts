import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { runtimeForOmitted } from "../src/agents";
import { ConfigError, DEFAULT_CONFIG, resolveDefaultRuntime, validateConfig, type DevConfig } from "../src/config";
import type { ConfigRepo } from "../src/configrepo";
import { getSchedule, insertSession, openDb, setRepoAgent, type SessionRuntime } from "../src/db";
import { joinableSessionId } from "../src/sessions";
import { fakeDeps } from "./helpers/apiHarness";

const withDefault = (runtime: SessionRuntime | undefined): DevConfig => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (runtime) cfg.settings.defaultRuntime = runtime;
  return cfg;
};

test("settings.defaultRuntime: absent = tmux, tmux/chat valid, anything else rejected", () => {
  expect(resolveDefaultRuntime(DEFAULT_CONFIG.settings)).toBe("tmux");
  expect(resolveDefaultRuntime(withDefault("chat").settings)).toBe("chat");
  expect(validateConfig(withDefault("chat")).settings.defaultRuntime).toBe("chat");
  expect(validateConfig(withDefault("tmux")).settings.defaultRuntime).toBe("tmux");
  const bad = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings, defaultRuntime: "vm" } };
  expect(() => validateConfig(bad)).toThrow(ConfigError);
  expect(() => validateConfig(bad)).toThrow("config.settings.defaultRuntime must be tmux or chat");
});

test("runtimeForOmitted: the default unless it cannot run the agent and the other runtime can", () => {
  expect(runtimeForOmitted("chat", "claude", "session")).toEqual({ runtime: "chat" });
  expect(runtimeForOmitted("tmux", "claude", "session")).toEqual({ runtime: "tmux" });
  expect(runtimeForOmitted("chat", "antigravity", "session"))
    .toEqual({ runtime: "tmux", notice: "Antigravity is not available in chat sessions yet, so this session runs in tmux" });
  expect(runtimeForOmitted("tmux", "vibe", "schedule"))
    .toEqual({ runtime: "chat", notice: "Mistral Vibe runs only in chat sessions, so this schedule runs in chat" });
});

test("joinableSessionId: tries the runtimes in order, ignores runtimes not listed", () => {
  const db = openDb(":memory:");
  const mk = (id: string, runtime: SessionRuntime, port: number) => insertSession(db, {
    id, folder: "f", project: "p", repo: "r", container: id, port_base: port, status: "running", solo: 0,
    created_at: 0, last_active_at: 0, important: 0, runtime });
  mk("dev-p-r", "tmux", 40100);
  expect(joinableSessionId(db, "p", "r", ["chat", "tmux"], false)).toBe("dev-p-r");
  expect(joinableSessionId(db, "p", "r", ["chat"], false)).toBeNull();
  mk("dev-p-r-2", "chat", 40200);
  expect(joinableSessionId(db, "p", "r", ["chat", "tmux"], false)).toBe("dev-p-r-2");
  expect(joinableSessionId(db, "p", "r", ["tmux", "chat"], false)).toBe("dev-p-r");
});

test("joinableSessionId: a running session of any listed runtime wins over a stopped one of the preferred runtime (S6-R17)", () => {
  const db = openDb(":memory:");
  const mk = (id: string, runtime: SessionRuntime, status: "running" | "stopped", port: number) => insertSession(db, {
    id, folder: "f", project: "x", repo: "r", container: id, port_base: port, status, solo: 0,
    created_at: 0, last_active_at: 0, important: 0, runtime });
  mk("dev-x-r", "tmux", "running", 40100);
  mk("dev-x-r-2", "chat", "stopped", 40200);
  expect(joinableSessionId(db, "x", "r", ["chat", "tmux"], false)).toBe("dev-x-r");
  // Nothing running: runtime order decides.
  db.run("UPDATE sessions SET status = 'stopped' WHERE id = 'dev-x-r'");
  expect(joinableSessionId(db, "x", "r", ["chat", "tmux"], false)).toBe("dev-x-r-2");
  // Both running: runtime order decides too.
  db.run("UPDATE sessions SET status = 'running'");
  expect(joinableSessionId(db, "x", "r", ["chat", "tmux"], false)).toBe("dev-x-r-2");
});

type OpenArgs = Record<string, unknown>;
function harness(initial: DevConfig, created = true) {
  let cfg = initial;
  const opens: OpenArgs[] = [];
  const solos: unknown[][] = [];
  const ibx: OpenArgs[] = [];
  const configRepo: ConfigRepo = { read: () => cfg, write: async (c) => { cfg = c; } };
  const db = openDb(":memory:");
  const mgr = {
    open: async (t: OpenArgs) => {
      opens.push(t);
      return { created, pull: { status: "clean" }, session: { id: "dev-p-r", status: "stopped", runtime: (t.runtime as string) ?? "tmux" } };
    },
    openSolo: async (...a: unknown[]) => { solos.push(a); return { created: true, pull: { status: "clean" }, session: { id: "dev-p-claudeSolo-1", status: "stopped", runtime: "tmux" } }; },
  };
  const app = createApp(fakeDeps({
    db, mgr: mgr as never, configRepo,
    instabox: { sessions: { startCreate: async (t: OpenArgs) => { ibx.push(t); return { id: "job-1", sessionId: "dev-p-r" }; } } } as never,
  }));
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, db, opens, solos, ibx, post, flip: (r: SessionRuntime) => { cfg = withDefault(r); } };
}
const BASE = { folder: "f", project: "p", repo: "r" };

test("POST /api/sessions without runtime follows the setting, read per request", async () => {
  const h = harness(withDefault(undefined));
  const first = await h.post("/api/sessions", BASE);
  expect(first.status).toBe(201);
  expect(h.opens[0]).toMatchObject({ runtime: "tmux", joinRuntimes: ["tmux", "chat"] });
  expect((await first.json() as { runtimeNotice?: string }).runtimeNotice).toBeUndefined();
  h.flip("chat");
  expect((await h.post("/api/sessions", BASE)).status).toBe(201);
  expect(h.opens[1]).toMatchObject({ runtime: "chat", joinRuntimes: ["chat", "tmux"] });
});

test("POST /api/sessions: an explicit runtime wins over the setting and joins only its own runtime", async () => {
  const h = harness(withDefault("chat"));
  const r = await h.post("/api/sessions", { ...BASE, runtime: "tmux" });
  expect(r.status).toBe(201);
  expect(h.opens[0]!.runtime).toBe("tmux");
  expect(h.opens[0]!.joinRuntimes).toBeUndefined();
  expect((await r.json() as { runtimeNotice?: string }).runtimeNotice).toBeUndefined();
  // An explicit chat for an agent chat cannot run is still refused, never switched.
  const agy = await h.post("/api/sessions", { ...BASE, runtime: "chat", agent: "antigravity" });
  expect(agy.status).toBe(400);
  expect(h.opens).toHaveLength(1);
});

test("POST /api/sessions: default chat, an agent chat cannot run (given or remembered) → tmux with runtimeNotice", async () => {
  const h = harness(withDefault("chat"));
  const given = await h.post("/api/sessions", { ...BASE, agent: "antigravity" });
  expect(given.status).toBe(201);
  expect(h.opens[0]).toMatchObject({ runtime: "tmux", joinRuntimes: ["tmux"] });
  const body = await given.json() as { session: { runtime: string }; runtimeNotice?: string };
  expect(body.session.runtime).toBe("tmux");
  expect(body.runtimeNotice).toBe("Antigravity is not available in chat sessions yet, so this session runs in tmux");
  setRepoAgent(h.db, "f", "p", "r", "antigravity", 1);
  const remembered = await h.post("/api/sessions", BASE);
  expect(h.opens[1]).toMatchObject({ runtime: "tmux", joinRuntimes: ["tmux"] });
  expect((await remembered.json() as { runtimeNotice?: string }).runtimeNotice).toContain("runs in tmux");
});

test("POST /api/sessions: default tmux, a chat-only agent → chat with runtimeNotice", async () => {
  const h = harness(withDefault("tmux"));
  const r = await h.post("/api/sessions", { ...BASE, agent: "vibe" });
  expect(h.opens[0]).toMatchObject({ runtime: "chat", joinRuntimes: ["chat"] });
  expect((await r.json() as { runtimeNotice?: string }).runtimeNotice).toBe("Mistral Vibe runs only in chat sessions, so this session runs in chat");
});

test("POST /api/sessions: joining an existing session carries no runtimeNotice", async () => {
  const h = harness(withDefault("chat"), false);
  const r = await h.post("/api/sessions", { ...BASE, agent: "antigravity" });
  expect(r.status).toBe(200);
  expect((await r.json() as { runtimeNotice?: string }).runtimeNotice).toBeUndefined();
});

test("POST /api/sessions: fresh with omitted runtime creates in the default runtime, joins nothing", async () => {
  const h = harness(withDefault("chat"));
  await h.post("/api/sessions", { ...BASE, fresh: true });
  expect(h.opens[0]).toMatchObject({ runtime: "chat", fresh: true });
});

test("POST /api/sessions: sessionId ignores the default (the stored runtime wins)", async () => {
  const h = harness(withDefault("chat"), false);
  insertSession(h.db, { id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100,
    status: "stopped", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux" });
  expect((await h.post("/api/sessions", { ...BASE, sessionId: "dev-p-r" })).status).toBe(200);
  expect(h.opens[0]!.runtime).toBeUndefined();
  expect(h.opens[0]!.joinRuntimes).toBeUndefined();
});

test("POST /api/sessions: solo stays tmux without a notice under default chat", async () => {
  const h = harness(withDefault("chat"));
  const r = await h.post("/api/sessions", { folder: "f", project: "p", solo: true });
  expect(r.status).toBe(201);
  expect(h.solos).toHaveLength(1);
  expect((await r.json() as { runtimeNotice?: string }).runtimeNotice).toBeUndefined();
});

test("POST /api/sessions host=instabox: 202 carries runtime tmux, plus runtimeNotice when the default is chat", async () => {
  const h = harness(withDefault("tmux"));
  const ibx = { ...BASE, cloneUrl: "https://git.example/x.git", host: "instabox" };
  const plain = await h.post("/api/sessions", ibx);
  expect(plain.status).toBe(202);
  expect(await plain.json()).toEqual({ jobId: "job-1", sessionId: "dev-p-r", runtime: "tmux" });
  h.flip("chat");
  const flipped = await h.post("/api/sessions", ibx);
  expect(flipped.status).toBe(202);
  expect(await flipped.json()).toEqual({ jobId: "job-1", sessionId: "dev-p-r", runtime: "tmux", runtimeNotice: "InstaBox sessions run in tmux" });
  // An explicit tmux asked for exactly that: no notice.
  const explicit = await h.post("/api/sessions", { ...ibx, runtime: "tmux" });
  expect(await explicit.json()).toEqual({ jobId: "job-1", sessionId: "dev-p-r", runtime: "tmux" });
});

const SCHEDULE = { name: "nightly", cron: "0 3 * * *", ...BASE, cloneUrl: "https://git.example/x.git", prompt: "run" };

test("POST /api/schedules without runtime stores the default at creation; explicit runtime wins", async () => {
  const h = harness(withDefault("chat"));
  const chat = await h.post("/api/schedules", SCHEDULE);
  expect(chat.status).toBe(201);
  const row = await chat.json() as { id: string; runtime: string; runtimeNotice?: string };
  expect(row.runtime).toBe("chat");
  expect(row.runtimeNotice).toBeUndefined();
  expect(getSchedule(h.db, row.id)!.runtime).toBe("chat");
  const tmux = await h.post("/api/schedules", { ...SCHEDULE, runtime: "tmux" });
  expect((await tmux.json() as { runtime: string }).runtime).toBe("tmux");
  const agy = await h.post("/api/schedules", { ...SCHEDULE, agent: "antigravity" });
  expect(await agy.json()).toMatchObject({ runtime: "tmux", runtimeNotice: "Antigravity is not available in chat sessions yet, so this schedule runs in tmux" });
});

test("a schedule keeps its stored runtime when the default flips (create, then flip, then edit)", async () => {
  const h = harness(withDefault("tmux"));
  const { id } = await (await h.post("/api/schedules", SCHEDULE)).json() as { id: string };
  expect(getSchedule(h.db, id)!.runtime).toBe("tmux");
  h.flip("chat");
  const put = await h.app.request(`/api/schedules/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "renamed" }) });
  expect(put.status).toBe(200);
  expect(getSchedule(h.db, id)).toMatchObject({ name: "renamed", runtime: "tmux" });
});

