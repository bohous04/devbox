import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { LoggedEvent } from "../../shared/thread";
import { AgentDisconnected, CommandFailed, CommandTimeout, type BridgeLinks } from "./bridgeLink";
import { SwitchRefused, type ChatSwitch, type SwitchRequest } from "./chatSwitch";
import { getSession, type SessionRow } from "./db";
import type { BusTopic, EventBus } from "./eventBus";
import type { Inbox } from "./sessionInbox";
import { storedRuntime } from "./sessions";
import type { ThreadStore } from "./threadStore";

export const SSE_PING_MS = 25_000;

export interface ThreadApiDeps {
  db: Database;
  mgr: { isEnding: (id: string) => boolean };
  links: Pick<BridgeLinks, "send" | "ensure" | "startTurnWhenConnected">;
  /** The session's thread store (index.ts: opened lazily, shared with its bridge link). */
  threads: (id: string) => ThreadStore;
  bus: EventBus;
  inbox: Inbox;
  /** Model, account and harness switching (chatSwitch.ts); without it those routes answer 503. */
  switcher?: Pick<ChatSwitch, "switch" | "target">;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A non-negative integer from a query/header value; null when it is anything else. */
function nonNegInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The outcome of a command the bridge did not confirm is unknown: never retried here. */
function commandError(c: Context, e: unknown): Response {
  // CommandTimeout extends AgentDisconnected: checked first, the message may have been queued.
  if (e instanceof CommandTimeout) return c.json({ error: "agent-timeout" }, 504);
  if (e instanceof AgentDisconnected) return c.json({ error: "agent-disconnected" }, 409);
  if (e instanceof CommandFailed) return c.json({ error: "command-failed", message: e.message }, 409);
  throw e;
}

const sseFrame = (event: string, data: unknown, id?: number) =>
  `event: ${event}\n${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;

/** Chat thread routes, the inbox and the SSE stream. Registered by createApp after its middleware. */
export function registerThreadRoutes(app: Hono, d: ThreadApiDeps | null): void {
  if (!d) {
    const off = (c: Context) => c.json({ error: "chat runtime is not configured" }, 503);
    for (const path of ["/api/sessions/:id/thread", "/api/sessions/:id/thread/*", "/api/inbox", "/api/stream"]) app.all(path, off);
    return;
  }
  /** The chat session's row and store, or the error response: 404 unknown, 409 tmux or ending. */
  const chat = (c: Context, id: string): { s: SessionRow; store: ThreadStore } | { res: Response } => {
    const s = getSession(d.db, id);
    if (!s) return { res: c.json({ error: "unknown session" }, 404) };
    if (storedRuntime(s) !== "chat") return { res: c.json({ error: "not-a-chat-session" }, 409) };
    // threads() refuses an ending session (its store is being archived); say so instead of a 500.
    if (d.mgr.isEnding(id)) return { res: c.json({ error: "session-ending" }, 409) };
    return { s, store: d.threads(id) };
  };

  app.get("/api/sessions/:id/thread", (c) => {
    const r = chat(c, c.req.param("id"));
    if ("res" in r) return r.res;
    const opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {};
    for (const key of ["afterSeq", "beforeSeq", "limit"] as const) {
      const raw = c.req.query(key);
      if (raw === undefined) continue;
      const n = nonNegInt(raw);
      if (n === null) return c.json({ error: `${key} must be a non-negative integer` }, 400);
      opts[key] = n;
    }
    return c.json(r.store.snapshot(opts));
  });

  app.post("/api/sessions/:id/thread/messages", async (c) => {
    const id = c.req.param("id");
    const r = chat(c, id);
    if ("res" in r) return r.res;
    const body = await c.req.json().catch(() => null);
    // Attachments are not supported yet: only {text}.
    if (!isRecord(body) || Object.keys(body).some((k) => k !== "text")) return c.json({ error: "body must be {text}" }, 400);
    if (typeof body.text !== "string" || body.text.trim() === "") return c.json({ error: "text must be a non-empty string" }, 400);
    try { await d.links.send(id, { kind: "startTurn", text: body.text }); }
    catch (e) { return commandError(c, e); }
    return c.json({ queued: true }, 202);
  });

  app.post("/api/sessions/:id/thread/interrupt", async (c) => {
    const id = c.req.param("id");
    const r = chat(c, id);
    if ("res" in r) return r.res;
    try { await d.links.send(id, { kind: "interrupt" }); }
    catch (e) { return commandError(c, e); }
    return c.body(null, 202);
  });

  app.post("/api/sessions/:id/thread/requests/:requestId", async (c) => {
    const id = c.req.param("id");
    const requestId = c.req.param("requestId");
    const r = chat(c, id);
    if ("res" in r) return r.res;
    const body = await c.req.json().catch(() => null);
    // Forwarded verbatim: plan approval is the exact string "Approve", anything else is the user's reply.
    if (!isRecord(body) || typeof body.answer !== "string" || body.answer === "") return c.json({ error: "answer must be a non-empty string" }, 400);
    if (!r.store.snapshot({ limit: 0 }).pending.some((p) => p.requestId === requestId)) return c.json({ error: "request-not-open" }, 409);
    try { await d.links.send(id, { kind: "answer", requestId, answer: body.answer }); }
    catch (e) { return commandError(c, e); }
    return c.body(null, 202);
  });

  /** Model, account and harness switches: 202 {kind} once the bridge confirmed (or `unchanged: true` when there was
   *  nothing to switch), 409 `run-active` while a run is active or queued, 400 for a bad request. */
  const switchRoute = (what: string, parse: (body: Record<string, unknown>) => SwitchRequest | string) =>
    app.post(`/api/sessions/:id/thread/${what}`, async (c) => {
      const id = c.req.param("id");
      const r = chat(c, id);
      if ("res" in r) return r.res;
      if (!d.switcher) return c.json({ error: "switching is not configured" }, 503);
      const body = await c.req.json().catch(() => null);
      const req = isRecord(body) ? parse(body) : "body must be a JSON object";
      if (typeof req === "string") return c.json({ error: req }, 400);
      try { return c.json(await d.switcher.switch(id, req), 202); }
      catch (e) {
        if (e instanceof SwitchRefused) return c.json(e.detail === undefined ? { error: e.code } : { error: e.code, message: e.detail }, e.status);
        return commandError(c, e);
      }
    });
  app.get("/api/sessions/:id/thread/target", (c) => {
    const id = c.req.param("id");
    const r = chat(c, id);
    if ("res" in r) return r.res;
    if (!d.switcher) return c.json({ error: "switching is not configured" }, 503);
    return c.json(d.switcher.target(id));
  });
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
  switchRoute("model", (b) => (nonEmpty(b.model) ? { kind: "model", model: b.model } : "model must be a non-empty string"));
  // No accountId: the pool's choice.
  switchRoute("account", (b) => (b.accountId === undefined ? { kind: "account" }
    : nonEmpty(b.accountId) ? { kind: "account", accountId: b.accountId } : "accountId must be a non-empty string"));
  switchRoute("harness", (b) => (nonEmpty(b.agent) ? { kind: "harness", agent: b.agent } : "agent must be a non-empty string"));

  app.post("/api/sessions/:id/thread/seen", async (c) => {
    const id = c.req.param("id");
    const r = chat(c, id);
    if ("res" in r) return r.res;
    const body = await c.req.json().catch(() => null);
    const seq = isRecord(body) ? body.seq : undefined;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > r.store.lastSeq()) {
      return c.json({ error: "seq must be an integer between 0 and the thread's lastSeq" }, 400);
    }
    r.store.markSeen(seq);
    d.inbox.changedSafe(id);
    return c.body(null, 204);
  });

  app.get("/api/inbox", (c) => c.json({ items: d.inbox.list() }));

  /** Server-sent events: `inbox` (InboxItem, coalesced per session by Inbox), `ping` every 25 s and, with
   *  `?session=<id>`, `thread` (LoggedEvent, `id: <seq>`) for that chat session only.
   *
   *  Replay contract (dashboard): with `Last-Event-ID: <seq>` (an EventSource reconnect) or `?afterSeq=<seq>` (first
   *  connect after loading the thread at that seq; the header wins when both are present) the stream first sends
   *  ONE `thread-snapshot` event `{afterSeq, snapshot}` with `id: snapshot.lastSeq`, then live `thread` events with
   *  seq > that id, each exactly once. The store keeps state, not raw events: `snapshot({afterSeq})` holds every item
   *  and run changed after that seq as whole rows, which replace the client's copies; pending, background and
   *  native replace wholesale.
   *
   *  text/event-stream is not compressed (hono's compress skips it); the ping keeps the connection under Bun's
   *  idleTimeout. */
  app.get("/api/stream", (c) => {
    const sessionId = c.req.query("session");
    let store: ThreadStore | null = null;
    if (sessionId !== undefined) {
      const r = chat(c, sessionId);
      if ("res" in r) return r.res;
      store = r.store;
    }
    let replayAfter: number | null = null;
    for (const [what, raw] of [["Last-Event-ID", c.req.header("last-event-id")], ["afterSeq", c.req.query("afterSeq")]] as const) {
      if (raw === undefined) continue;
      if (!store) return c.json({ error: `${what} needs ?session=` }, 400);
      const n = nonNegInt(raw);
      if (n === null) return c.json({ error: `${what} must be a non-negative integer` }, 400);
      replayAfter ??= n; // the header (checked first) wins
    }

    const enc = new TextEncoder();
    let stop = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        let closed = false;
        const send = (s: string) => {
          if (closed) return;
          // The stream is broken (closed or errored without cancel): stop so the bus drops this listener.
          try { ctrl.enqueue(enc.encode(s)); }
          catch { stop(); }
        };
        // Every thread event sent has a seq above this: drops what the replay snapshot already holds
        // and any duplicate delivery.
        let sentSeq = -1;
        const topics: BusTopic[] = sessionId === undefined ? ["inbox"] : ["inbox", `thread:${sessionId}`];
        // Subscribed BEFORE the store is read, so nothing published in between is lost.
        const unsubscribe = d.bus.subscribe(topics, (topic, data) => {
          if (topic === "inbox") { send(sseFrame("inbox", data)); return; }
          const e = data as LoggedEvent;
          if (e.seq <= sentSeq) return;
          sentSeq = e.seq;
          send(sseFrame("thread", e, e.seq));
        });
        const ping = setInterval(() => send(sseFrame("ping", {})), SSE_PING_MS);
        stop = () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsubscribe();
        };
        c.req.raw.signal.addEventListener("abort", stop);
        // Chrome fires EventSource `open` only once body bytes arrive; without this comment a stream with no replay
        // stayed "connecting" until the first ping (25 s) and the inbox, which loads on `open`, stayed empty.
        send(": open\n\n");
        if (store && replayAfter !== null) {
          const snapshot = store.snapshot({ afterSeq: replayAfter });
          sentSeq = Math.max(sentSeq, snapshot.lastSeq);
          send(sseFrame("thread-snapshot", { afterSeq: replayAfter, snapshot }, snapshot.lastSeq));
        }
      },
      cancel() { stop(); },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
    });
  });
}
