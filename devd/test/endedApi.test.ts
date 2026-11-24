import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { openDb, type SessionRow } from "../src/db";
import { recordEnded } from "../src/endedSessions";
import { EventBus } from "../src/eventBus";
import { ThreadStore } from "../src/threadStore";
import { png } from "./helpers/images";
import type { ContinueResult, EndedSession } from "../../shared/ended";
import type { BridgeEvent, ThreadSnapshot } from "../../shared/thread";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const S: SessionRow = {
  id: "dev-acme-app", folder: "acme", project: "acme", repo: "app", container: "dev-acme-app", port_base: 40100,
  status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "chat", branch: "main",
};
const ID = "dev-acme-app-20261120-101500";
const IMG = "0b1c2d3e-0000-4000-8000-000000000002.png";

const CONVO: BridgeEvent[] = [
  { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
  { type: "message.final", runId: "r1", itemId: "u1", role: "user", text: "Make the header sticky", attachments: [`/inbox/dev-acme-app/${IMG}`] },
  { type: "message.final", runId: "r1", itemId: "a1", role: "assistant", text: "Done: the header sticks to the top." },
  { type: "run.completed", runId: "r1", nativeThreadId: "n", usage: null, costUsd: null },
];

const THREAD = "0b1c2d3e-0000-4000-8000-000000000001";

/** `claude`: the session's Claude conversation (thread.native) and its jsonl in the archive; `imageBlock`: what devd
 *  says about an image that cannot take a resume. */
function setup(o: { runtime?: "chat" | "tmux"; remote?: string; open?: (t: Record<string, unknown>) => Promise<unknown>; claude?: boolean; codex?: boolean; imageBlock?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ended-api-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", ID);
  mkdirSync(join(dir, "images"), { recursive: true });
  writeFileSync(join(dir, "images", IMG), png(1, 1));
  const store = ThreadStore.openFile(join(dir, o.runtime === "tmux" ? "dev-acme-app.mirror.sqlite" : "dev-acme-app.sqlite"));
  const native = o.claude ? "claude" : o.codex ? "codex" : null;
  const events_: BridgeEvent[] = native ? [{ type: "thread.native", harness: native, nativeThreadId: THREAD, account: null, model: null }, ...CONVO] : CONVO;
  events_.forEach((event, i) => store.apply({ seq: i + 1, ts: 1000 * (i + 1), event }));
  store.close();
  if (o.claude) writeFileSync(join(dir, `${THREAD}.jsonl`), '{"type":"user"}\n');
  recordEnded(db, { ...S, runtime: o.runtime ?? "chat", ...(o.codex ? { agent: "codex" } : {}) }, dir, 5_000);
  const bus = new EventBus();
  const events: unknown[] = [];
  bus.subscribe(["inbox-ended"], (_t, data) => events.push(data));
  const opened: Record<string, unknown>[] = [];
  const firstTurns: [string, string][] = [];
  const open = o.open ?? (async (t: Record<string, unknown>) => ({ created: true, session: { ...S, id: "dev-acme-app-2", runtime: t.runtime, status: "running" } }));
  const a = createApp({
    db, root, mgr: { isEnding: () => false, resumeImageBlock: async () => o.imageBlock ?? null, open: async (t: Record<string, unknown>) => { opened.push(t); return open(t); } } as never,
    cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }), cloneQueue: {} as never,
    configRepo: { read: () => ({ version: 1, settings: {}, folders: {} }) } as never, dashboardDir: root, bus,
    remoteAddr: () => o.remote ?? "127.0.0.1",
    links: { send: async () => {}, ensure: () => {}, startTurnWhenConnected: (id: string, text: string) => { firstTurns.push([id, text]); }, hasFirstTurn: () => false },
  } as never);
  return { a, db, root, events, opened, firstTurns };
}

const post = (path: string) => new Request(`http://x${path}`, { method: "POST" });

test("GET /api/ended lists the ended session with the mode continue will use", async () => {
  const t = setup();
  const r = await t.a.fetch(new Request("http://x/api/ended"));
  const { items } = (await r.json()) as { items: EndedSession[] };
  expect(items.map((e) => [e.id, e.topic, e.continueMode])).toEqual([[ID, "Make the header sticky", "handoff"]]);
});

test("GET /api/ended/:id is the one transcript's entry, a hidden one too", async () => {
  const t = setup();
  await t.a.fetch(post(`/api/ended/${ID}/hide`));
  const r = await t.a.fetch(new Request(`http://x/api/ended/${ID}`));
  expect(((await r.json()) as EndedSession).id).toBe(ID);
  expect((await t.a.fetch(new Request("http://x/api/ended/nope"))).status).toBe(404);
});

test("GET transcript is the thread snapshot shape, with paging; an unknown id is 404", async () => {
  const t = setup();
  const snap = (await (await t.a.fetch(new Request(`http://x/api/ended/${ID}/transcript`))).json()) as ThreadSnapshot;
  expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
  expect(snap.lastSeq).toBe(4);
  const last = (await (await t.a.fetch(new Request(`http://x/api/ended/${ID}/transcript?limit=1`))).json()) as ThreadSnapshot;
  expect(last.items.map((i) => i.kind)).toEqual(["assistant"]);
  // The tail leaves the first message out: the topic still names the transcript.
  expect(last.topic).toBe("Make the header sticky");
  expect((await t.a.fetch(new Request(`http://x/api/ended/${ID}/transcript?limit=x`))).status).toBe(400);
  expect((await t.a.fetch(new Request("http://x/api/ended/nope/transcript"))).status).toBe(404);
});

test("the transcript's images are served from the archive", async () => {
  const t = setup();
  const r = await t.a.fetch(new Request(`http://x/api/ended/${ID}/attachments/${IMG}`));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/png");
  expect((await t.a.fetch(new Request(`http://x/api/ended/${ID}/attachments/..%2Fdev-acme-app.sqlite`))).status).toBe(404);
});

test("hide takes the transcript out of the list and tells the inbox stream", async () => {
  const t = setup();
  expect((await t.a.fetch(post(`/api/ended/${ID}/hide`))).status).toBe(204);
  expect(((await (await t.a.fetch(new Request("http://x/api/ended"))).json()) as { items: unknown[] }).items).toEqual([]);
  expect(t.events).toEqual([{ id: ID, removed: true }]);
  // Hiding again changes nothing and says nothing.
  expect((await t.a.fetch(post(`/api/ended/${ID}/hide`))).status).toBe(204);
  expect(t.events.length).toBe(1);
  expect((await t.a.fetch(post("/api/ended/nope/hide"))).status).toBe(404);
});

test("continue opens a new chat session in the same repo with the handoff as its first message", async () => {
  const t = setup();
  const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect(r.status).toBe(201);
  expect((await r.json()) as ContinueResult).toEqual({ mode: "handoff", sessionId: "dev-acme-app-2", runtime: "chat", reason: null });
  expect(t.opened).toEqual([{ folder: "acme", project: "acme", repo: "app", agent: "claude", runtime: "chat", fresh: true, handoff: expect.stringContaining("Make the header sticky") }]);
  expect(t.firstTurns.length).toBe(1);
  expect(t.firstTurns[0]![1]).toContain("/run/devd/ended-transcript.md");
  // The transcript goes to the new session alone (open's `handoff`), never into the /inbox every container mounts.
  expect(existsSync(join(t.root, "_inbox"))).toBe(false);
});

test("continue gives a tmux session the handoff as its first prompt", async () => {
  const t = setup({ runtime: "tmux" });
  const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect(((await r.json()) as ContinueResult).runtime).toBe("tmux");
  expect(t.opened[0]).toMatchObject({ runtime: "tmux", fresh: true });
  expect(String(t.opened[0]!.firstPrompt)).toContain("/run/devd/ended-transcript.md");
  expect(t.firstTurns).toEqual([]);
});

test("continue is refused from a container, for an unknown id, and reports a failed open", async () => {
  expect((await setup({ remote: "172.17.0.5" }).a.fetch(post(`/api/ended/${ID}/continue`))).status).toBe(403);
  expect((await setup().a.fetch(post("/api/ended/nope/continue"))).status).toBe(404);
  const t = setup({ open: async () => { throw new Error("clone failed"); } });
  const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toBe("clone failed");
});

test("a transcript gone from the archive is 410 to read and 409 to hand off; nothing is opened", async () => {
  const t = setup();
  rmSync(join(t.root, "_chat-archive", ID, "dev-acme-app.sqlite"));
  expect((await t.a.fetch(new Request(`http://x/api/ended/${ID}/transcript`))).status).toBe(410);
  const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error: string }).error).toContain("nothing to hand off");
  expect(t.opened).toEqual([]);
});

test("a second continue while the first still starts its session is refused, and allowed once it is done", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t = setup({ open: async (o) => { await gate; return { created: true, session: { ...S, id: "dev-acme-app-2", runtime: o.runtime, status: "running" } }; } });
  const first = t.a.fetch(post(`/api/ended/${ID}/continue`));
  await new Promise((r) => setTimeout(r, 20));
  const second = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect(second.status).toBe(409);
  expect(((await second.json()) as { error: string }).error).toContain("already being continued");
  release();
  expect((await first).status).toBe(201);
  expect((await t.a.fetch(post(`/api/ended/${ID}/continue`))).status).toBe(201);
});

test("continue resumes the Claude conversation: the new session gets its jsonl and no handoff message", async () => {
  for (const runtime of ["chat", "tmux"] as const) {
    const t = setup({ claude: true, runtime });
    expect(((await (await t.a.fetch(new Request("http://x/api/ended"))).json()) as { items: EndedSession[] }).items[0]!.continueMode).toBe("resume");
    const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
    expect(r.status).toBe(201);
    expect((await r.json()) as ContinueResult).toEqual({ mode: "resume", sessionId: "dev-acme-app-2", runtime, reason: null });
    expect(t.opened).toEqual([{ folder: "acme", project: "acme", repo: "app", agent: "claude", runtime, fresh: true,
      resume: { harness: "claude", thread: THREAD, jsonl: Buffer.from('{"type":"user"}\n') } }]);
    expect(t.firstTurns).toEqual([]);
    expect(existsSync(join(t.root, "_inbox", "_ended", `${ID}.md`))).toBe(false);
  }
});

test("continue resumes a Codex chat thread by its id alone; a tmux Codex session hands off", async () => {
  const t = setup({ codex: true });
  const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect((await r.json()) as ContinueResult).toEqual({ mode: "resume", sessionId: "dev-acme-app-2", runtime: "chat", reason: null });
  expect(t.opened).toEqual([{ folder: "acme", project: "acme", repo: "app", agent: "codex", runtime: "chat", fresh: true,
    resume: { harness: "codex", thread: THREAD } }]);
  expect(t.firstTurns).toEqual([]);
  const tmux = setup({ codex: true, runtime: "tmux" });
  const h = (await (await tmux.a.fetch(post(`/api/ended/${ID}/continue`))).json()) as ContinueResult;
  expect(h).toMatchObject({ mode: "handoff", reason: null });
  expect(tmux.opened[0]!.resume).toBeUndefined();
});

test("a resume the image cannot take, or a conversation gone since the list, hands off and says why", async () => {
  const t = setup({ claude: true, imageBlock: "the session image predates resume support (rebuild it with devbox-update)" });
  const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect((await r.json()) as ContinueResult).toEqual({ mode: "handoff", sessionId: "dev-acme-app-2", runtime: "chat",
    reason: "the session image predates resume support (rebuild it with devbox-update)" });
  expect(t.opened[0]!.resume).toBeUndefined();
  // The new session's first message says it too, where the user reads it.
  expect(t.firstTurns[0]![1]).toContain("could not be resumed: the session image predates resume support");
  const gone = setup({ claude: true });
  rmSync(join(gone.root, "_chat-archive", ID, `${THREAD}.jsonl`));
  const g = (await (await gone.a.fetch(post(`/api/ended/${ID}/continue`))).json()) as ContinueResult;
  expect(g.mode).toBe("handoff");
  expect(g.reason).toContain("not in the archive");
});
