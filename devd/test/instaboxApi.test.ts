import { afterEach, beforeEach, expect, test } from "bun:test";
import { createApp } from "../src/api";
import type { AgentName } from "../src/db";
import { getSession, insertSession, listSessions, setRepoAgent } from "../src/db";
import { killOrphan, reconcile } from "../src/instabox/reconcile";
import { fakeDeps } from "./helpers/apiHarness";
import { IBX_SETTINGS, ibxSetup, T, waitJob } from "./helpers/instaboxSetup";

let env: ReturnType<typeof ibxSetup>;
let app: ReturnType<typeof createApp>;
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const create = async () => {
  const j = await (await app.request("/api/sessions", json({ ...T, host: "instabox" }))).json() as { jobId: string; sessionId: string };
  await waitJob(env.ibx, j.jobId);
  return j;
};

beforeEach(() => {
  env = ibxSetup();
  app = createApp(fakeDeps({
    db: env.db, mgr: env.mgr,
    instabox: {
      sessions: env.ibx, settings: IBX_SETTINGS,
      hostLoad: () => ({ memUsedPct: 90, load1: 1, cores: 4 }),
      status: () => reconcile(env.db, env.client, async () => null),
      rebuildBase: () => ({ jobId: "b1" }), baseJob: () => null,
      killOrphan: (id) => killOrphan(env.db, env.client, id),
    },
  }));
});
afterEach(() => env.cleanup());

test("POST /api/sessions host=instabox → 202 with jobId, job completes, /api/sessions carries dockerHost", async () => {
  const res = await app.request("/api/sessions", json({ ...T, host: "instabox" }));
  expect(res.status).toBe(202);
  const j = await res.json() as { jobId: string; sessionId: string };
  expect(j.sessionId).toBe("dev-p-r");
  expect((await waitJob(env.ibx, j.jobId)).status).toBe("done");
  expect(((await (await app.request(`/api/instabox/jobs/${j.jobId}`)).json()) as { status: string }).status).toBe("done");
  expect((await app.request("/api/instabox/jobs/neexistuje")).status).toBe(404);
  const rows = await (await app.request("/api/sessions")).json() as { id: string; host: string; dockerHost: string | null }[];
  expect(rows.find((r) => r.id === "dev-p-r")).toMatchObject({ host: "instabox", dockerHost: "ibx-m_1" });
});

test("R3: existing VPS session of the repo → instabox creates another session (202, not 409)", async () => {
  insertSession(env.db, { id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100, status: "stopped", solo: 0, created_at: 1, last_active_at: 1, important: 0 });
  const res = await app.request("/api/sessions", json({ ...T, host: "instabox" }));
  expect(res.status).toBe(202);
  expect(((await res.json()) as { sessionId: string }).sessionId).toBe("dev-p-r-2");
});

test("validation: solo 400, invalid host 400, missing cloneUrl 400, full 409", async () => {
  expect((await app.request("/api/sessions", json({ folder: "f", project: "p", solo: true, host: "instabox" }))).status).toBe(400);
  expect((await app.request("/api/sessions", json({ ...T, host: "mars" }))).status).toBe(400);
  expect((await app.request("/api/sessions", json({ folder: "f", project: "p", repo: "r", host: "instabox" }))).status).toBe(400);
  env.client.maxMachines = 0;
  expect((await app.request("/api/sessions", json({ ...T, host: "instabox" }))).status).toBe(409);
});

test("proxy agent (claude-gpt/claude-grok) on InstaBox → 400, even when only remembered for the repo; claude/codex/grok pass", async () => {
  for (const agent of ["claude-gpt", "claude-grok"]) {
    const res = await app.request("/api/sessions", json({ ...T, host: "instabox", agent }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not supported on InstaBox");
  }
  setRepoAgent(env.db, "f", "p", "r", "claude-gpt", 1);
  expect((await app.request("/api/sessions", json({ ...T, host: "instabox" }))).status).toBe(400);
  expect(listSessions(env.db)).toHaveLength(0);
  for (const agent of ["claude", "codex", "grok"]) {
    const res = await app.request("/api/sessions", json({ ...T, host: "instabox", agent }));
    expect(res.status).toBe(202);
    await waitJob(env.ibx, ((await res.json()) as { jobId: string }).jobId);
  }
});

test("without instabox deps: create 503, status enabled:false, placement vps", async () => {
  const bare = createApp(fakeDeps());
  expect((await bare.request("/api/sessions", json({ ...T, host: "instabox" }))).status).toBe(503);
  expect(await (await bare.request("/api/instabox/status")).json()).toEqual({ enabled: false });
  expect(await (await bare.request("/api/placement")).json()).toMatchObject({ suggest: "vps", reason: null });
});

test("GET /api/instabox/status during an API outage → 200 ok:false", async () => {
  env.client.failNext.set("list", new Error("ECONNREFUSED"));
  const res = await app.request("/api/instabox/status");
  expect(res.status).toBe(200);
  const s = await res.json() as { ok: boolean; error: string };
  expect(s.ok).toBe(false);
  expect(s.error).toContain("ECONNREFUSED");
});

test("GET /api/placement recommends instabox at 90 % RAM", async () => {
  expect(await (await app.request("/api/placement")).json()).toMatchObject({ suggest: "instabox", reason: "RAM 90 %" });
});

test("desktop-link: VPS 404, instabox running → url, control revokes, stopped → 409, DELETE 204", async () => {
  insertSession(env.db, { id: "dev-p-v", folder: "f", project: "p", repo: "v", container: "dev-p-v", port_base: 40200, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0 });
  expect((await app.request("/api/sessions/dev-p-v/desktop-link", json({}))).status).toBe(404);
  await create();
  const view = await (await app.request("/api/sessions/dev-p-r/desktop-link", json({}))).json() as { url: string };
  expect(view.url).toContain("dashboard.instabox.sh");
  await app.request("/api/sessions/dev-p-r/desktop-link", json({ control: true }));
  expect(env.client.calls).toContain("desktopLink m_1 false");
  expect((await app.request("/api/sessions/dev-p-r/desktop-link", { method: "DELETE" })).status).toBe(204);
  await env.mgr.stop("dev-p-r");
  expect((await app.request("/api/sessions/dev-p-r/desktop-link", json({}))).status).toBe(409);
});

test("guards: critic, /api/open, /api/preview, clipboard file and recreate for an instabox session → 409", async () => {
  await create();
  expect((await app.request("/api/sessions/dev-p-r/critic", json({ critic: true }))).status).toBe(409);
  expect((await app.request("/api/sessions/dev-p-r/critic", json({ critic: false }))).status).toBe(204);
  expect((await app.request("/api/open", json({ sessionId: "dev-p-r", path: "/workspace" }))).status).toBe(409);
  expect((await app.request("/api/preview", json({ sessionId: "dev-p-r", containerPort: 3000 }))).status).toBe(409);
  expect((await app.request("/api/clipboard/file?session=dev-p-r")).status).toBe(409);
  expect((await app.request("/api/clipboard/image?session=dev-p-r&target=shared")).status).toBe(409);
  expect((await app.request("/api/sessions/dev-p-r/recreate", { method: "POST" })).status).toBe(409);
});

test("DELETE /api/instabox/machines/:id deletes only an orphaned machine", async () => {
  const orphan = await env.client.create("sn", { name: "orph", metadata: { devbox: "1", session: "dev-x-gone" } });
  await create();
  const owned = getSession(env.db, "dev-p-r")!.instabox_machine_id!;
  expect((await app.request(`/api/instabox/machines/${owned}`, { method: "DELETE" })).status).toBe(409);
  expect((await app.request(`/api/instabox/machines/${orphan.id}`, { method: "DELETE" })).status).toBe(204);
  expect(env.client.machines.has(orphan.id)).toBe(false);
});

test("GET /api/instabox/status: a status dep that throws returns 200 ok:false, not 500", async () => {
  const throwing = createApp(fakeDeps({
    db: env.db, mgr: env.mgr,
    instabox: {
      sessions: env.ibx, settings: IBX_SETTINGS, hostLoad: () => ({ memUsedPct: 0, load1: 0, cores: 4 }),
      status: async () => { throw new Error("boom"); },
      rebuildBase: () => null, baseJob: () => null, killOrphan: async () => false,
    },
  }));
  const res = await throwing.request("/api/instabox/status");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ enabled: true, ok: false, error: "boom" });
});

test("DELETE desktop-link on a paused session → 204 without calling the InstaBox API (the machine is not woken)", async () => {
  await create();
  await env.mgr.stop("dev-p-r");
  const before = env.client.calls.length;
  expect((await app.request("/api/sessions/dev-p-r/desktop-link", { method: "DELETE" })).status).toBe(204);
  expect(env.client.calls.slice(before)).toEqual([]);
});

test("M10: antigravity on InstaBox → 400 on create (also as the repo's remembered agent)", async () => {
  const res = await app.request("/api/sessions", json({ ...T, host: "instabox", agent: "antigravity" }));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("not supported on InstaBox");
  setRepoAgent(env.db, "f", "p", "r", "antigravity", 1);
  expect((await app.request("/api/sessions", json({ ...T, host: "instabox" }))).status).toBe(400);
  expect(listSessions(env.db)).toHaveLength(0);
});

test("I4/M10: live agent switch of an InstaBox session to a proxy agent or antigravity → 400 without switchAgent; VPS session passes", async () => {
  const switched: string[] = [];
  app = createApp(fakeDeps({
    db: env.db, mgr: env.mgr,
    switchAgent: async (id: string, agent: AgentName) => { switched.push(`${id} ${agent}`); return { status: "switched", panes: [] } as never; },
  }));
  insertSession(env.db, { id: "dev-p-i", folder: "f", project: "p", repo: "i", container: "dev-p-i", port_base: 40300, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0, host: "instabox", instabox_machine_id: "m_9" });
  insertSession(env.db, { id: "dev-p-v", folder: "f", project: "p", repo: "v", container: "dev-p-v", port_base: 40310, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0 });
  for (const agent of ["claude-gpt", "claude-openrouter", "antigravity"]) {
    const r = await app.request("/api/sessions/dev-p-i/agent", json({ agent }));
    expect([agent, r.status]).toEqual([agent, 400]);
    expect(((await r.json()) as { error: string }).error).toContain("not supported on InstaBox");
  }
  expect(switched).toEqual([]);
  expect((await app.request("/api/sessions/dev-p-i/agent", json({ agent: "codex" }))).status).toBe(200);
  expect((await app.request("/api/sessions/dev-p-v/agent", json({ agent: "claude-gpt" }))).status).toBe(200);
  expect(switched).toEqual(["dev-p-i codex", "dev-p-v claude-gpt"]);
});

test("M7: desktop-link refresh in control mode does not invalidate old links; an explicit takeover does", async () => {
  await create();
  const n = () => env.client.calls.filter((c) => c === "desktopRevoke m_1").length;
  await app.request("/api/sessions/dev-p-r/desktop-link", json({ control: true }));
  expect(n()).toBe(1);
  const r = await app.request("/api/sessions/dev-p-r/desktop-link", json({ control: true, refresh: true }));
  expect(r.status).toBe(200);
  expect(n()).toBe(1);
  expect(env.client.calls.at(-1)).toBe("desktopLink m_1 false");
});

test("M8: POST /api/sessions with sessionId reopens exactly the paused InstaBox session, even if the repo has a running VPS session", async () => {
  await create();
  await env.mgr.stop("dev-p-r");
  insertSession(env.db, { id: "dev-p-r-2", folder: "f", project: "p", repo: "r", container: "dev-p-r-2", port_base: 40400, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0 });
  const { cloneUrl: _c, ...repo } = T;
  const r = await app.request("/api/sessions", json({ ...repo, sessionId: "dev-p-r" }));
  expect(r.status).toBe(200);
  expect(((await r.json()) as { session: { id: string; host: string; status: string } }).session).toMatchObject({ id: "dev-p-r", host: "instabox", status: "running" });
  expect(env.client.calls).toContain("resume m_1");
  expect((await app.request("/api/sessions", json({ ...repo, sessionId: "dev-p-nope" }))).status).toBe(404);
  expect((await app.request("/api/sessions", json({ ...repo, repo: "jine", sessionId: "dev-p-r" }))).status).toBe(404);
  expect((await app.request("/api/sessions", json({ ...repo, sessionId: "dev-p-r", fresh: true }))).status).toBe(400);
});
