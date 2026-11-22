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

function setup(o: { runtime?: "chat" | "tmux"; remote?: string; open?: (t: Record<string, unknown>) => Promise<unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ended-api-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", ID);
  mkdirSync(join(dir, "images"), { recursive: true });
  writeFileSync(join(dir, "images", IMG), png(1, 1));
  const store = ThreadStore.openFile(join(dir, o.runtime === "tmux" ? "dev-acme-app.mirror.sqlite" : "dev-acme-app.sqlite"));
  CONVO.forEach((event, i) => store.apply({ seq: i + 1, ts: 1000 * (i + 1), event }));
  store.close();
  recordEnded(db, { ...S, runtime: o.runtime ?? "chat" }, dir, 5_000);
  const bus = new EventBus();
  const events: unknown[] = [];
  bus.subscribe(["inbox-ended"], (_t, data) => events.push(data));
  const opened: Record<string, unknown>[] = [];
  const firstTurns: [string, string][] = [];
  const open = o.open ?? (async (t: Record<string, unknown>) => ({ created: true, session: { ...S, id: "dev-acme-app-2", runtime: t.runtime, status: "running" } }));
  const a = createApp({
    db, root, mgr: { isEnding: () => false, open: async (t: Record<string, unknown>) => { opened.push(t); return open(t); } } as never,
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

test("GET transcript is the thread snapshot shape, with paging; an unknown id is 404", async () => {
  const t = setup();
  const snap = (await (await t.a.fetch(new Request(`http://x/api/ended/${ID}/transcript`))).json()) as ThreadSnapshot;
  expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
  expect(snap.lastSeq).toBe(4);
  const last = (await (await t.a.fetch(new Request(`http://x/api/ended/${ID}/transcript?limit=1`))).json()) as ThreadSnapshot;
  expect(last.items.map((i) => i.kind)).toEqual(["assistant"]);
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
  expect((await r.json()) as ContinueResult).toEqual({ mode: "handoff", sessionId: "dev-acme-app-2", runtime: "chat" });
  expect(t.opened).toEqual([{ folder: "acme", project: "acme", repo: "app", agent: "claude", runtime: "chat", fresh: true }]);
  expect(t.firstTurns.length).toBe(1);
  expect(t.firstTurns[0]![1]).toContain(`/inbox/_ended/${ID}.md`);
  expect(readFileSync(join(t.root, "_inbox", "_ended", `${ID}.md`), "utf8")).toContain("Make the header sticky");
});

test("continue gives a tmux session the handoff as its first prompt", async () => {
  const t = setup({ runtime: "tmux" });
  const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect(((await r.json()) as ContinueResult).runtime).toBe("tmux");
  expect(t.opened[0]).toMatchObject({ runtime: "tmux", fresh: true });
  expect(String(t.opened[0]!.firstPrompt)).toContain(`/inbox/_ended/${ID}.md`);
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

test("nothing is written for the handoff when the transcript is gone", async () => {
  const t = setup();
  rmSync(join(t.root, "_chat-archive", ID, "dev-acme-app.sqlite"));
  const r = await t.a.fetch(post(`/api/ended/${ID}/continue`));
  expect(r.status).toBe(500);
  expect(t.opened).toEqual([]);
  expect(existsSync(join(t.root, "_inbox", "_ended", `${ID}.md`))).toBe(false);
});
