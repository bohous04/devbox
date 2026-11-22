import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { AgentEventHub } from "../src/agentEvents";
import { AgentDisconnected, CommandFailed, CommandTimeout } from "../src/bridgeLink";
import { getSession, getSeenAt, insertSession, listSessions, openDb, type SessionRow } from "../src/db";
import { EventBus } from "../src/eventBus";
import { Inbox } from "../src/sessionInbox";
import type { ResetTarget } from "../src/sessionAttention";
import { ThreadStore } from "../src/threadStore";
import { stageThreadImage } from "../src/threadImages";
import { png } from "./helpers/images";
import type { BridgeCommand } from "../../image/agent-bridge/src/protocol";
import type { BridgeEvent, LoggedEvent, ThreadItem, ThreadSnapshot } from "../../shared/thread";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const CHAT: SessionRow = {
  id: "dev-a-chat", folder: "acme", project: "a", repo: "chat", container: "dev-a-chat",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "chat",
};
const CHAT2: SessionRow = { ...CHAT, id: "dev-a-chat2", container: "dev-a-chat2", repo: "chat2", port_base: 40300 };
const TMUX: SessionRow = { ...CHAT, id: "dev-a-tmux", container: "dev-a-tmux", repo: "tmux", port_base: 40200, runtime: "tmux" };

const started = (runId: string): BridgeEvent => ({ type: "run.started", runId, origin: "user", nativeThreadId: null, model: null });
const completed = (runId: string): BridgeEvent => ({ type: "run.completed", runId, nativeThreadId: "n", usage: null, costUsd: null });
const said = (runId: string, itemId: string, text: string): BridgeEvent => ({ type: "message.final", runId, itemId, role: "assistant", text });
const asked = (runId: string, requestId: string): BridgeEvent => ({ type: "request.opened", runId, requestId, kind: "question", prompt: "Which one?" });

function setup(opts: { sendError?: Error; open?: (t: unknown) => Promise<unknown>; untilReset?: (s: SessionRow) => ResetTarget; noUntilReset?: boolean; bridgeVersion?: string | null } = {}) {
  const db = openDb(":memory:");
  for (const r of [CHAT, CHAT2, TMUX]) insertSession(db, r);
  const dir = mkdtempSync(join(tmpdir(), "thread-api-"));
  const stores = new Map<string, ThreadStore>();
  cleanups.push(() => { for (const s of stores.values()) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const bus = new EventBus();
  // Like index.ts: a devd notice goes out on the session's thread topic.
  const threads = (id: string) => {
    let s = stores.get(id);
    if (!s) { s = ThreadStore.open(dir, id, { onNotice: (item) => bus.publish(`thread:${id}`, { notice: item }) }); stores.set(id, s); }
    return s;
  };
  const sent: [string, BridgeCommand][] = [];
  const ensured: string[] = [];
  const firstTurns: [string, string][] = [];
  const links = {
    send: async (id: string, cmd: BridgeCommand) => {
      sent.push([id, cmd]);
      if (opts.sendError) throw opts.sendError;
    },
    ensure: (id: string) => { ensured.push(id); },
    startTurnWhenConnected: (id: string, text: string) => { firstTurns.push([id, text]); },
  };
  const hub = new AgentEventHub({ db, notify: () => {} });
  const inbox = new Inbox({
    db, sessions: () => listSessions(db), session: (id) => getSession(db, id), threads,
    chatLink: () => ({ status: "connected", since: 1 }), tmuxLive: (id) => hub.liveSnapshot(id), bus,
    now: () => 1_000_000, coalesceMs: 0,
  });
  const ending = new Set<string>();
  const a = createApp({
    db, mgr: { isEnding: (id: string) => ending.has(id), open: opts.open ?? (async () => { throw new Error("no open"); }) } as never,
    cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: dir, tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: { read: () => ({ version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} }) } as never, dashboardDir: dir, agentEvents: hub,
    links, threads, bus, inbox, bridgeVersion: () => (opts.bridgeVersion === undefined ? "1.4.0" : opts.bridgeVersion), untilReset: opts.noUntilReset ? undefined : opts.untilReset ?? (() => ({ reason: "No usage limit is active on this account" })),
  } as never);
  /** Applies events to a session's store and publishes them like index.ts does (store first, then the bus). */
  const feed = (id: string, events: BridgeEvent[]) => {
    const s = threads(id);
    const out: LoggedEvent[] = [];
    for (const event of events) {
      const e = { seq: s.lastSeq() + 1, ts: 1000 * (s.lastSeq() + 1), event };
      s.apply(e);
      bus.publish(`thread:${id}`, e);
      out.push(e);
    }
    return out;
  };
  return { a, db, dir, threads, sent, ensured, firstTurns, bus, inbox, feed, ending };
}

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method, headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// --- GET thread ---

test("GET thread returns the snapshot, honours afterSeq and limit", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), said("r1", "m1", "one"), said("r1", "m2", "two"), completed("r1")]);
  const all = await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread`));
  expect(all.status).toBe(200);
  const snap = (await all.json()) as ThreadSnapshot;
  expect(snap.lastSeq).toBe(4);
  expect(snap.items.map((i) => i.text)).toEqual(["one", "two"]);
  const last = (await (await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread?limit=1`))).json()) as ThreadSnapshot;
  expect(last.items.map((i) => i.text)).toEqual(["two"]);
  const after = (await (await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread?afterSeq=2`))).json()) as ThreadSnapshot;
  expect(after.items.map((i) => i.text)).toEqual(["two"]);
});

test("GET thread beforeSeq pages back and leaves the rest of the snapshot as it was", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), said("r1", "m1", "one"), said("r1", "m2", "two"), said("r1", "m3", "three")]);
  const get = async (q: string) => (await (await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread?${q}`))).json()) as ThreadSnapshot;
  expect((await get("beforeSeq=4")).items.map((i) => i.text)).toEqual(["one", "two"]);
  expect((await get("beforeSeq=4&limit=1")).items.map((i) => i.text)).toEqual(["two"]);
  expect((await get("beforeSeq=2")).items).toEqual([]);
  const full = await get("");
  expect(full.items.map((i) => i.text)).toEqual(["one", "two", "three"]);
  expect((await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread?beforeSeq=-1`))).status).toBe(400);
});

test("GET thread: unknown session 404, tmux 409, bad afterSeq/limit 400, ending session 409", async () => {
  const t = setup();
  expect((await t.a.fetch(req("GET", "/api/sessions/dev-nope/thread"))).status).toBe(404);
  const tmux = await t.a.fetch(req("GET", `/api/sessions/${TMUX.id}/thread`));
  expect(tmux.status).toBe(409);
  expect(await tmux.json()).toEqual({ error: "not-a-chat-session" });
  for (const q of ["afterSeq=-1", "afterSeq=x", "limit=1.5", "limit=-2"]) {
    expect((await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread?${q}`))).status).toBe(400);
  }
  t.ending.add(CHAT.id);
  const ending = await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread`));
  expect(ending.status).toBe(409);
  expect(await ending.json()).toEqual({ error: "session-ending" });
});

// --- commands ---

test("POST messages sends startTurn with the exact text and answers 202 queued", async () => {
  const t = setup();
  const text = "  keep   my spacing\n";
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, { text }));
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ queued: true });
  expect(t.sent).toEqual([[CHAT.id, { kind: "startTurn", text }]]);
});

test("POST messages: empty text, missing text and extra fields are 400; nothing is sent", async () => {
  const t = setup();
  for (const body of [{ text: "" }, { text: "   " }, {}, { text: 5 }, { text: "hi", attachments: ["/inbox/a.png"] }, "hi", null]) {
    const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, body));
    expect(r.status).toBe(400);
  }
  expect(t.sent).toEqual([]);
});

// --- images ---

const PNG = png(10, 10);

test("POST messages with attachments staged for this session sends them with startTurn", async () => {
  const t = setup();
  const a = stageThreadImage(t.dir, CHAT.id, PNG);
  const b = stageThreadImage(t.dir, CHAT.id, PNG);
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, { text: "what is this?", attachments: [{ path: a }, { path: b }] }));
  expect(r.status).toBe(202);
  expect(t.sent).toEqual([[CHAT.id, { kind: "startTurn", text: "what is this?", attachments: [a, b] }]]);
});

test("POST messages: attachments that are not this session's staged images are 400; nothing is sent", async () => {
  const t = setup();
  const own = stageThreadImage(t.dir, CHAT.id, PNG);
  const other = stageThreadImage(t.dir, CHAT2.id, PNG);
  const name = own.split("/").pop()!;
  for (const attachments of [
    "x", [own], [{ path: other }], [{ path: `/inbox/${name}` }], [{ path: `/inbox/${CHAT.id}/../${CHAT.id}/${name}` }],
    [{ path: `/inbox/${CHAT.id}/00000000-0000-4000-8000-000000000000.png` }], [{ path: own, extra: 1 }], [{}],
  ]) {
    const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, { text: "hi", attachments }));
    expect(r.status).toBe(400);
  }
  expect(t.sent).toEqual([]);
});

test("POST messages: at most 10 images per message (11 is 400, nothing is sent)", async () => {
  const t = setup();
  const paths = Array.from({ length: 11 }, () => ({ path: stageThreadImage(t.dir, CHAT.id, PNG) }));
  const over = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, { text: "many", attachments: paths }));
  expect(over.status).toBe(400);
  expect(((await over.json()) as { error: string }).error).toBe("at most 10 images per message");
  expect(t.sent).toEqual([]);
  expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, { text: "ten", attachments: paths.slice(0, 10) }))).status).toBe(202);
});

test("POST messages with attachments to a bridge older than 1.4.0 is 409 bridge-too-old; text alone still goes", async () => {
  for (const version of ["1.3.0", null]) {
    const t = setup({ bridgeVersion: version });
    const path = stageThreadImage(t.dir, CHAT.id, PNG);
    const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, { text: "see", attachments: [{ path }] }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("bridge-too-old");
    expect(t.sent).toEqual([]);
    expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, { text: "see", attachments: [] }))).status).toBe(202);
    expect(t.sent).toEqual([[CHAT.id, { kind: "startTurn", text: "see" }]]);
  }
});

test("GET thread attachment serves this session's staged image with its type; anything else 404", async () => {
  const t = setup();
  const path = stageThreadImage(t.dir, CHAT.id, PNG);
  const name = path.split("/").pop()!;
  const r = await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread/attachments/${name}`));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/png");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
  expect((await t.a.fetch(req("GET", `/api/sessions/${CHAT2.id}/thread/attachments/${name}`))).status).toBe(404);
  expect((await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread/attachments/notes.txt`))).status).toBe(404);
  expect((await t.a.fetch(req("GET", `/api/sessions/${TMUX.id}/thread/attachments/${name}`))).status).toBe(409);
});

test("POST messages to unknown 404 and tmux 409", async () => {
  const t = setup();
  expect((await t.a.fetch(req("POST", "/api/sessions/dev-nope/thread/messages", { text: "hi" }))).status).toBe(404);
  expect((await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/thread/messages`, { text: "hi" }))).status).toBe(409);
  expect(t.sent).toEqual([]);
});

test("command errors: timeout 504 agent-timeout (checked before disconnected), disconnected 409, failed 409 with message", async () => {
  const cases: [Error, number, unknown][] = [
    [new CommandTimeout("slow"), 504, { error: "agent-timeout" }],
    [new AgentDisconnected("gone"), 409, { error: "agent-disconnected" }],
    [new CommandFailed("run is active"), 409, { error: "command-failed", message: "run is active" }],
  ];
  for (const [err, status, body] of cases) {
    const t = setup({ sendError: err });
    for (const r of [
      await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/messages`, { text: "hi" })),
      await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/interrupt`)),
    ]) {
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual(body);
    }
    expect(t.sent.length).toBe(2); // never retried
  }
});

test("POST interrupt sends interrupt and answers 202", async () => {
  const t = setup();
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/interrupt`));
  expect(r.status).toBe(202);
  expect(t.sent).toEqual([[CHAT.id, { kind: "interrupt" }]]);
});

test("POST requests forwards the answer verbatim for an open request", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), { type: "request.opened", runId: "r1", requestId: "q1", kind: "plan", prompt: "Plan?" }]);
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/requests/q1`, { answer: "Approve" }));
  expect(r.status).toBe(202);
  expect(t.sent).toEqual([[CHAT.id, { kind: "answer", requestId: "q1", answer: "Approve" }]]);
});

test("POST requests: unknown or resolved request 409, missing answer 400", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), asked("r1", "q1"), { type: "request.resolved", requestId: "q1", answer: "A", by: "user" }]);
  const unknown = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/requests/q9`, { answer: "A" }));
  expect(unknown.status).toBe(409);
  expect(await unknown.json()).toEqual({ error: "request-not-open" });
  expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/requests/q1`, { answer: "A" }))).status).toBe(409);
  t.feed(CHAT.id, [asked("r1", "q2")]);
  for (const body of [{}, { answer: 1 }, { answer: "" }]) {
    expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/requests/q2`, body))).status).toBe(400);
  }
  expect(t.sent).toEqual([]);
});

test("POST seen marks the seq seen (204); out of range or non-integer is 400", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  for (const seq of [3, -1, 1.5, "2", undefined]) {
    expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/seen`, { seq }))).status).toBe(400);
  }
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/seen`, { seq: 2 }));
  expect(r.status).toBe(204);
  expect(t.threads(CHAT.id).snapshot({ limit: 0 }).seenSeq).toBe(2);
  expect(getSeenAt(t.db, CHAT.id)).toBe(1_000_000); // the look, for the auto-settle clock
});

test("POST seen publishes the session's new inbox state", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  const got: unknown[] = [];
  t.bus.subscribe(["inbox"], (_t, d) => got.push(d));
  await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/seen`, { seq: 2 }));
  expect(got).toMatchObject([{ sessionId: CHAT.id, attention: { section: "idle" } }]);
});

test("POST tmux seen (204) records the look and publishes the new inbox state; unknown 404, chat 409, ending 409", async () => {
  const t = setup();
  const got: unknown[] = [];
  t.bus.subscribe(["inbox"], (_t, d) => got.push(d));
  const r = await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/seen`));
  expect(r.status).toBe(204);
  expect(getSeenAt(t.db, TMUX.id)).toBe(1_000_000);
  expect(got).toMatchObject([{ sessionId: TMUX.id }]);
  expect((await t.a.fetch(req("POST", "/api/sessions/nope/seen"))).status).toBe(404);
  const chat = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/seen`));
  expect(chat.status).toBe(409);
  expect(await chat.json()).toEqual({ error: "not-a-tmux-session" });
  t.ending.add(TMUX.id);
  expect((await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/seen`))).status).toBe(409);
});

// --- inbox ---

test("GET inbox lists every session with its attention, needs_you first", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), said("r1", "m1", "all done"), completed("r1")]);
  t.feed(CHAT2.id, [started("r1"), asked("r1", "q1")]);
  const r = await t.a.fetch(req("GET", "/api/inbox"));
  expect(r.status).toBe(200);
  const { items } = (await r.json()) as { items: { sessionId: string; runtime: string; attention: { section: string; since: number }; lastText: string | null }[] };
  expect(items.map((i) => [i.sessionId, i.runtime, i.attention.section])).toEqual([
    [CHAT2.id, "chat", "needs_you"], // request opened at 2000
    [CHAT.id, "chat", "needs_you"], // completed at 3000
    [TMUX.id, "tmux", "idle"],
  ]);
  expect(items[1].lastText).toBe("all done");
});

// --- open starts the link ---

test("a chat session opened with a pull conflict gets the conflict prompt as its first message; tmux does not", async () => {
  const conflict = { status: "conflict", files: ["a.ts"] };
  for (const [row, pull, expected] of [
    [CHAT, conflict, [[CHAT.id, "resolve a.ts"]]],
    [CHAT, { status: "ok" }, []],
    [TMUX, conflict, []],
  ] as const) {
    const claudePrompt = pull.status === "conflict" ? "resolve a.ts" : undefined;
    const t = setup({ open: async () => ({ session: row, created: false, pull, claudePrompt }) });
    const r = await t.a.fetch(req("POST", "/api/sessions", { folder: row.folder, project: row.project, repo: row.repo }));
    expect(r.status).toBe(200);
    expect(t.firstTurns).toEqual(expected.map((e) => [...e]));
  }
});

test("opening a session publishes its inbox item", async () => {
  for (const row of [CHAT, TMUX]) {
    const t = setup({ open: async () => ({ session: row, created: false }) });
    const got: unknown[] = [];
    t.bus.subscribe(["inbox"], (_t, d) => got.push(d));
    const r = await t.a.fetch(req("POST", "/api/sessions", { folder: row.folder, project: row.project, repo: row.repo }));
    expect(r.status).toBe(200);
    expect(got).toEqual([expect.objectContaining({ sessionId: row.id })]);
  }
});

test("opening a chat session starts its bridge link right away; a tmux session does not", async () => {
  for (const [row, expected] of [[CHAT, [CHAT.id]], [TMUX, []]] as const) {
    const t = setup({ open: async () => ({ session: row, created: false }) });
    const r = await t.a.fetch(req("POST", "/api/sessions", { folder: row.folder, project: row.project, repo: row.repo }));
    expect(r.status).toBe(200);
    expect(t.ensured).toEqual([...expected]);
  }
});

// --- SSE ---

/** Reads SSE frames until `n` events (not comments) arrived, then cancels the stream. */
async function readEvents(res: Response, n: number, ms = 2000): Promise<{ event: string; id?: string; data: unknown }[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: { event: string; id?: string; data: unknown }[] = [];
  const deadline = Date.now() + ms;
  while (out.length < n) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const chunk = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
    if (!chunk || chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f: { event: string; id?: string; data: unknown } = { event: "message", data: undefined };
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) f.event = line.slice(7);
        else if (line.startsWith("id: ")) f.id = line.slice(4);
        else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
      }
      if (frame.startsWith(":")) continue;
      out.push(f);
    }
  }
  await reader.cancel();
  return out;
}

test("SSE stream is text/event-stream and not compressed", async () => {
  const t = setup();
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`, undefined, { "accept-encoding": "gzip" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/event-stream");
  expect(res.headers.get("content-encoding")).toBeNull();
  await res.body!.cancel();
});

test("SSE delivers a thread event for the subscribed session and not for others", async () => {
  const t = setup();
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`));
  const events = readEvents(res, 2);
  await Bun.sleep(10);
  t.feed(CHAT2.id, [started("x1")]);
  const [mine] = t.feed(CHAT.id, [started("r1")]);
  const [mine2] = t.feed(CHAT.id, [said("r1", "m1", "hi")]);
  const got = await events;
  expect(got).toEqual([
    { event: "thread", id: "1", data: mine },
    { event: "thread", id: "2", data: mine2 },
  ]);
});

test("SSE without a session gets inbox events but no thread events", async () => {
  const t = setup();
  const res = await t.a.fetch(req("GET", "/api/stream"));
  const events = readEvents(res, 1);
  await Bun.sleep(10);
  t.feed(CHAT.id, [started("r1")]);
  t.inbox.changed(CHAT.id);
  const got = await events;
  expect(got.length).toBe(1);
  expect(got[0].event).toBe("inbox");
  expect(got[0].data).toMatchObject({ sessionId: CHAT.id, attention: { section: "working" } });
});

test("SSE sends a comment at once, so a browser EventSource opens before the first event or ping", async () => {
  const t = setup();
  for (const path of ["/api/stream", `/api/stream?session=${CHAT.id}`]) {
    const res = await t.a.fetch(req("GET", path));
    const reader = res.body!.getReader();
    const first = await Promise.race([reader.read(), Bun.sleep(200).then(() => null)]);
    expect(first).not.toBeNull();
    expect(new TextDecoder().decode(first!.value)).toBe(": open\n\n");
    await reader.cancel();
  }
});

test("SSE: unknown session 404, tmux session 409, Last-Event-ID without session or not an integer 400", async () => {
  const t = setup();
  expect((await t.a.fetch(req("GET", "/api/stream?session=dev-nope"))).status).toBe(404);
  expect((await t.a.fetch(req("GET", `/api/stream?session=${TMUX.id}`))).status).toBe(409);
  expect((await t.a.fetch(req("GET", "/api/stream", undefined, { "last-event-id": "3" }))).status).toBe(400);
  expect((await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`, undefined, { "last-event-id": "x" }))).status).toBe(400);
});

test("SSE reconnect with Last-Event-ID gets everything after it exactly once: a snapshot, then live events", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), said("r1", "m1", "seen before"), said("r1", "m2", "missed")]);
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`, undefined, { "last-event-id": "2" }));
  const events = readEvents(res, 3);
  await Bun.sleep(10);
  const live = t.feed(CHAT.id, [said("r1", "m3", "live"), completed("r1")]);
  const got = await events;
  expect(got.length).toBe(3);
  expect(got[0].event).toBe("thread-snapshot");
  expect(got[0].id).toBe("3");
  const { afterSeq, snapshot } = got[0].data as { afterSeq: number; snapshot: ThreadSnapshot };
  expect(afterSeq).toBe(2);
  expect(snapshot.lastSeq).toBe(3);
  expect(snapshot.items.map((i) => i.text)).toEqual(["missed"]);
  expect(got.slice(1)).toEqual(live.map((e) => ({ event: "thread", id: String(e.seq), data: e })));
});

test("SSE replay boundary: a live event already in the snapshot is not sent twice", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1")]);
  // The snapshot sent on connect already holds seq 1.
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`, undefined, { "last-event-id": "0" }));
  const events = readEvents(res, 3, 300);
  await Bun.sleep(10);
  // Re-publish an old event (as a duplicate delivery would): it must be dropped by seq.
  t.bus.publish(`thread:${CHAT.id}`, { seq: 1, ts: 1000, event: started("r1") });
  const [next] = t.feed(CHAT.id, [said("r1", "m1", "hi")]);
  const got = await events;
  expect(got.map((e) => [e.event, e.id])).toEqual([["thread-snapshot", "1"], ["thread", String(next.seq)]]);
});

test("SSE: a devd notice added out of band reaches a live subscriber, and a replay from its seq", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1")]);
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`));
  const events = readEvents(res, 1);
  await Bun.sleep(10);
  t.threads(CHAT.id).addNotice("Could not resume the earlier claude thread", 5000);
  const notice: ThreadItem = { seq: 1, runId: null, itemId: "notice:1", kind: "notice", text: "Could not resume the earlier claude thread", status: "done", ts: 5000 };
  // No id: it does not move the client's Last-Event-ID (seqs are the bridge's).
  expect(await events).toEqual([{ event: "thread-notice", data: notice }]);
  // A client that was at seq 1 while it was down gets it in the replay snapshot.
  const again = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`, undefined, { "last-event-id": "1" }));
  const [snap] = await readEvents(again, 1);
  expect((snap.data as { snapshot: ThreadSnapshot }).snapshot.items).toEqual([notice]);
});

test("SSE unsubscribes from the bus when the client goes away", async () => {
  const t = setup();
  const before = t.bus.subscriberCount();
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`));
  expect(t.bus.subscriberCount()).toBe(before + 1);
  await res.body!.cancel();
  expect(t.bus.subscriberCount()).toBe(before);
});

test("SSE ?afterSeq replays like Last-Event-ID: load the thread at K, stream from K, everything after K exactly once", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), said("r1", "m1", "loaded")]);
  const k = ((await (await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread`))).json()) as ThreadSnapshot).lastSeq;
  t.feed(CHAT.id, [said("r1", "m2", "in between")]); // after the GET, before the stream opens
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}&afterSeq=${k}`));
  const events = readEvents(res, 3);
  await Bun.sleep(10);
  const live = t.feed(CHAT.id, [said("r1", "m3", "live"), completed("r1")]);
  const got = await events;
  expect(got[0].event).toBe("thread-snapshot");
  expect(got[0].id).toBe(String(k + 1));
  const { afterSeq, snapshot } = got[0].data as { afterSeq: number; snapshot: ThreadSnapshot };
  expect(afterSeq).toBe(k);
  expect(snapshot.items.map((i) => i.text)).toEqual(["in between"]);
  expect(got.slice(1)).toEqual(live.map((e) => ({ event: "thread", id: String(e.seq), data: e })));
});

test("SSE: the Last-Event-ID header wins over ?afterSeq; an invalid afterSeq is 400", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), said("r1", "m1", "one"), said("r1", "m2", "two")]);
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}&afterSeq=0`, undefined, { "last-event-id": "2" }));
  const [first] = await readEvents(res, 1);
  expect((first.data as { afterSeq: number }).afterSeq).toBe(2);
  for (const q of ["afterSeq=-1", "afterSeq=x", "afterSeq=1.5"]) {
    expect((await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}&${q}`))).status).toBe(400);
  }
  expect((await t.a.fetch(req("GET", "/api/stream?afterSeq=1"))).status).toBe(400);
});

test("a failing inbox update does not fail a handled seen request", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.bus.subscribe(["inbox"], () => { throw new Error("subscriber"); }); // the bus logs this itself
  (t.inbox as unknown as { publish: () => void }).publish = () => { throw new Error("inbox broke"); };
  const err = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => err.mockRestore());
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/seen`, { seq: 2 }));
  expect(r.status).toBe(204);
  expect(String(err.mock.calls[0]?.[0])).toContain("inbox broke");
  expect(t.threads(CHAT.id).snapshot({ limit: 0 }).seenSeq).toBe(2);
});

test("a chat session whose link cannot start still opens", async () => {
  const t = setup({ open: async () => ({ session: CHAT, created: true }) });
  (t as unknown as { ensured: string[] }).ensured.push = () => { throw new Error("link broke"); };
  const err = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => err.mockRestore());
  const r = await t.a.fetch(req("POST", "/api/sessions", { folder: CHAT.folder, project: CHAT.project, repo: CHAT.repo }));
  expect(r.status).toBe(201);
  expect(String(err.mock.calls[0]?.[0])).toContain("bridge link of opened session");
});

// --- settle and snooze (tmux sessions too) ---

test("POST settle and unsettle work for chat and tmux sessions and answer the new inbox item", async () => {
  const t = setup();
  for (const id of [CHAT.id, TMUX.id]) {
    const r = await t.a.fetch(req("POST", `/api/sessions/${id}/settle`));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { attention: { section: string } }).attention.section).toBe("settled");
    const u = await t.a.fetch(req("POST", `/api/sessions/${id}/unsettle`));
    expect(u.status).toBe(200);
    expect(((await u.json()) as { attention: { section: string } }).attention.section).not.toBe("settled");
  }
});

test("POST snooze {until} and {untilReset} for a tmux session", async () => {
  const t = setup({ untilReset: () => ({ resetsAt: 1_000_000 + 7_200_000 }) });
  const r = await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/snooze`, { until: 1_000_000 + 3_600_000 }));
  expect(r.status).toBe(200);
  expect(((await r.json()) as { attention: unknown }).attention).toMatchObject({ section: "snoozed", until: 1_000_000 + 3_600_000 });
  const u = await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/snooze`, { untilReset: true }));
  expect(u.status).toBe(200);
  expect(((await u.json()) as { attention: unknown }).attention).toMatchObject({ section: "snoozed", until: 1_000_000 + 7_200_000 });
});

test("POST snooze: no active limit is 409 with the reason; a bad body is 400; unknown session 404, ending 409", async () => {
  const t = setup();
  const r = await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/snooze`, { untilReset: true }));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "no-active-limit", message: "No usage limit is active on this account" });
  for (const body of [{}, { until: 999_999 }, { until: "soon" }, { until: 2_000_000, untilReset: true }, { untilReset: false }, { until: 2_000_000, x: 1 }]) {
    expect((await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/snooze`, body))).status).toBe(400);
  }
  expect((await t.a.fetch(req("POST", "/api/sessions/nope/settle"))).status).toBe(404);
  t.ending.add(TMUX.id);
  expect((await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/settle`))).status).toBe(409);
});

test("GET snooze-reset tells when the active limit resets, or why snoozing until it is not possible", async () => {
  const t = setup({ untilReset: (s) => (s.runtime === "tmux" ? { resetsAt: 5_000_000 } : { reason: "Mistral Vibe has no usage limit devbox can read" }) });
  expect(await (await t.a.fetch(req("GET", `/api/sessions/${TMUX.id}/snooze-reset`))).json()).toEqual({ resetsAt: 5_000_000 });
  expect(await (await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/snooze-reset`))).json()).toEqual({ reason: "Mistral Vibe has no usage limit devbox can read" });
});

test("settle and snooze refuse a session with an open request: 409 request-open; nothing is written", async () => {
  const t = setup();
  t.feed(CHAT.id, [started("r1"), asked("r1", "q1")]);
  for (const [path, body] of [["settle", undefined], ["snooze", { until: 2_000_000 }]] as const) {
    const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/${path}`, body));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "request-open", message: "Answer the open request first: a session waiting for you cannot be settled or snoozed" });
  }
  expect(t.inbox.item(getSession(t.db, CHAT.id)!).attention.section).toBe("needs_you");
});

test("snooze until reset without the usage dependency is 503; settle and the thread routes still work", async () => {
  const t = setup({ noUntilReset: true });
  expect((await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/snooze`, { untilReset: true }))).status).toBe(503);
  expect((await t.a.fetch(req("GET", `/api/sessions/${TMUX.id}/snooze-reset`))).status).toBe(503);
  expect((await t.a.fetch(req("POST", `/api/sessions/${TMUX.id}/settle`))).status).toBe(200);
  expect((await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread`))).status).toBe(200);
});

// --- effort (bridge 1.7.0) ---

const effortState = (supported: string[] | null, chosen: string | null = null): BridgeEvent =>
  ({ type: "effort.state", model: "claude-opus-5-5", supported, effective: null, chosen });

test("GET thread carries the latest effort.state; null before one", async () => {
  const t = setup({ bridgeVersion: "1.7.0" });
  const before = (await (await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread`))).json()) as ThreadSnapshot;
  expect(before.effort).toBeNull();
  t.feed(CHAT.id, [effortState(["low", "high"]), effortState(["low", "high"], "high")]);
  const snap = (await (await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread`))).json()) as ThreadSnapshot;
  expect(snap.effort).toEqual({ model: "claude-opus-5-5", supported: ["low", "high"], effective: null, chosen: "high" });
});

test("POST thread/effort sends setEffort, also during a run; null goes back to the model default", async () => {
  const t = setup({ bridgeVersion: "1.7.0" });
  t.feed(CHAT.id, [effortState(["low", "high"]), started("r1")]);
  expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, { effort: "high" }))).status).toBe(202);
  expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, { effort: null }))).status).toBe(202);
  expect(t.sent).toEqual([[CHAT.id, { kind: "setEffort", effort: "high" }], [CHAT.id, { kind: "setEffort", effort: null }]]);
});

test("POST thread/effort refuses a malformed body and a level the model does not list, sending nothing", async () => {
  const t = setup({ bridgeVersion: "1.7.0" });
  // Before any effort.state too: a bad value would make the bridge drop devd's link.
  for (const body of [{}, { effort: "" }, { effort: 3 }, { effort: "High!" }, { effort: "turbo" }]) {
    expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, body))).status).toBe(400);
  }
  t.feed(CHAT.id, [effortState(["low", "high"])]);
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, { effort: "max" }));
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "unsupported-effort", message: "claude-opus-5-5 takes low, high" });
  expect(t.sent).toEqual([]);
});

test("POST thread/effort before the model's levels are known: an unchecked level goes to the bridge, another is refused", async () => {
  const t = setup({ bridgeVersion: "1.8.0" });
  t.feed(CHAT.id, [{ type: "effort.state", model: null, supported: null, effective: null, chosen: null, unchecked: ["low", "high", "max"] }]);
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, { effort: "minimal" }));
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "unsupported-effort", message: "before its first reply the agent takes low, high, max (checked on that message)" });
  expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, { effort: "max" }))).status).toBe(202);
  expect(t.sent).toEqual([[CHAT.id, { kind: "setEffort", effort: "max" }]]);
});

test("POST thread/effort to a bridge older than 1.7.0 is 409 bridge-too-old with what to do", async () => {
  for (const version of ["1.6.0", null]) {
    const t = setup({ bridgeVersion: version });
    const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, { effort: "high" }));
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("bridge-too-old");
    expect(body.message).toContain("recreate the session's container");
    expect(t.sent).toEqual([]);
  }
});

test("POST thread/effort: the bridge's refusal comes back as 409 command-failed with its reason", async () => {
  const t = setup({ bridgeVersion: "1.7.0", sendError: new CommandFailed("the agent has not reported its effort levels yet") });
  const r = await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, { effort: "high" }));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "command-failed", message: "the agent has not reported its effort levels yet" });
});

test("SSE: an effort.state goes out parsed as thread-effort, never as a thread event (older apps show those as unknown)", async () => {
  const t = setup({ bridgeVersion: "1.7.0" });
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`));
  const events = readEvents(res, 2);
  await Bun.sleep(10);
  t.feed(CHAT.id, [{ type: "effort.state", model: "claude-opus-5-5", supported: ["low", "turbo", "high"], effective: "x".repeat(500), chosen: "high" }]);
  const [next] = t.feed(CHAT.id, [started("r1")]);
  expect(await events).toEqual([
    { event: "thread-effort", data: { model: "claude-opus-5-5", supported: ["low", "high"], effective: null, chosen: "high" } },
    { event: "thread", id: "2", data: next },
  ]);
});

test("SSE: commands.changed goes out as thread-commands (the current harness's list), never as a thread event; a harness switch sends the new harness's", async () => {
  const t = setup({ bridgeVersion: "1.9.0" });
  const res = await t.a.fetch(req("GET", `/api/stream?session=${CHAT.id}`));
  const events = readEvents(res, 5);
  await Bun.sleep(10);
  const [claude] = t.feed(CHAT.id, [{ type: "thread.native", harness: "claude", nativeThreadId: "t-1", account: null, model: "m" }]);
  t.feed(CHAT.id, [{ type: "commands.changed", commands: [{ name: "compact", hint: "<instructions>" }, { name: "two words" }] } as unknown as BridgeEvent]);
  const [codex] = t.feed(CHAT.id, [{ type: "thread.native", harness: "codex", nativeThreadId: "t-2", account: null, model: "gpt" }]);
  expect(await events).toEqual([
    { event: "thread", id: "1", data: claude },
    { event: "thread-commands", data: null },
    { event: "thread-commands", data: [{ name: "compact", hint: "<instructions>" }] },
    { event: "thread", id: "3", data: codex },
    { event: "thread-commands", data: null },
  ]);
});

test("a malformed effort.state is stored as nothing known: the snapshot stays readable and POST thread/effort answers", async () => {
  const t = setup({ bridgeVersion: "1.7.0" });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    t.feed(CHAT.id, [{ type: "effort.state", model: "m".repeat(200), supported: 5, effective: {}, chosen: "A".repeat(100_000) } as unknown as BridgeEvent]);
    const snap = (await (await t.a.fetch(req("GET", `/api/sessions/${CHAT.id}/thread`))).json()) as ThreadSnapshot;
    expect(snap.effort).toEqual({ model: null, supported: null, effective: null, chosen: null });
    expect((await t.a.fetch(req("POST", `/api/sessions/${CHAT.id}/thread/effort`, { effort: "high" }))).status).toBe(202);
    const logged = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("thread store: effort"));
    expect(logged).toHaveLength(4);
    expect(logged.every((l) => l.length < 200)).toBe(true);
  } finally {
    errors.mockRestore();
  }
});
