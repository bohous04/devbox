import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { EFFORT_MIN_BRIDGE_VERSION, IMAGES_MIN_BRIDGE_VERSION, versionAtLeast } from "../../shared/bridgeVersion";
import { isKnownEffort, KNOWN_EFFORT_LEVELS } from "../../shared/effort";
import type { LoggedEvent } from "../../shared/thread";
import { AgentDisconnected, CommandFailed, CommandTimeout, type BridgeLinks } from "./bridgeLink";
import { SwitchRefused, type ChatSwitch, type SwitchRequest } from "./chatSwitch";
import { getSession, type SessionRow } from "./db";
import type { BusTopic, EventBus } from "./eventBus";
import { REQUEST_OPEN, type ResetTarget } from "./sessionAttention";
import type { Inbox } from "./sessionInbox";
import { storedRuntime } from "./sessions";
import { threadImageByName, threadImageFile } from "./threadImages";
import type { ThreadStore } from "./threadStore";

export const SSE_PING_MS = 25_000;
/** S5-R23; the dashboard's Composer stops at the same number. */
export const MAX_IMAGES_PER_MESSAGE = 10;

export interface ThreadApiDeps {
  db: Database;
  /** devd's data root: chat images live in `<root>/_inbox/<sessionId>` (threadImages.ts). */
  root: string;
  mgr: { isEnding: (id: string) => boolean };
  links: Pick<BridgeLinks, "send" | "ensure" | "startTurnWhenConnected">;
  /** The session's thread store (index.ts: opened lazily, shared with its bridge link). */
  threads: (id: string) => ThreadStore;
  bus: EventBus;
  inbox: Inbox;
  /** Model, account and harness switching (chatSwitch.ts); without it those routes answer 503. */
  switcher?: Pick<ChatSwitch, "switch" | "target">;
  /** When the session's active usage limit resets, or why that is not known (sessionAttention.untilReset); without
   *  it only "snooze until reset" and snooze-reset answer 503. */
  untilReset?: (s: SessionRow) => ResetTarget;
  /** The session's bridge version from its latest handshake (chatSwitch.ts); null before one or for a 1.0.0 bridge. */
  bridgeVersion: (sessionId: string) => string | null;
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
    for (const path of ["/api/sessions/:id/thread", "/api/sessions/:id/thread/*", "/api/inbox", "/api/stream",
      "/api/sessions/:id/settle", "/api/sessions/:id/unsettle", "/api/sessions/:id/snooze", "/api/sessions/:id/snooze-reset"]) app.all(path, off);
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
    if (!isRecord(body) || Object.keys(body).some((k) => k !== "text" && k !== "attachments")) {
      return c.json({ error: "body must be {text, attachments?}" }, 400);
    }
    if (typeof body.text !== "string" || body.text.trim() === "") return c.json({ error: "text must be a non-empty string" }, 400);
    const attachments = body.attachments === undefined ? [] : body.attachments;
    if (!Array.isArray(attachments)) return c.json({ error: "attachments must be an array of {path}" }, 400);
    if (attachments.length > MAX_IMAGES_PER_MESSAGE) return c.json({ error: `at most ${MAX_IMAGES_PER_MESSAGE} images per message` }, 400);
    const paths: string[] = [];
    for (const a of attachments) {
      if (!isRecord(a) || Object.keys(a).some((k) => k !== "path") || typeof a.path !== "string" || threadImageFile(d.root, id, a.path) === null) {
        return c.json({ error: "attachments must be images uploaded to this session (POST /api/sessions/:id/inbox?for=thread)" }, 400);
      }
      paths.push(a.path);
    }
    if (paths.length > 0) {
      // A 1.2.0/1.3.0 bridge parses attachments but refuses the turn; say why before sending.
      const version = d.bridgeVersion(id);
      if (version === null || !versionAtLeast(version, IMAGES_MIN_BRIDGE_VERSION)) {
        return c.json({ error: "bridge-too-old", message: `this session's agent bridge (${version ?? "unknown version"}) cannot take images; it needs ${IMAGES_MIN_BRIDGE_VERSION} — recreate the session's container` }, 409);
      }
    }
    try { await d.links.send(id, paths.length > 0 ? { kind: "startTurn", text: body.text, attachments: paths } : { kind: "startTurn", text: body.text }); }
    catch (e) { return commandError(c, e); }
    return c.json({ queued: true }, 202);
  });

  // The thread's images for the dashboard; uuid names, so a cached copy never goes stale.
  app.get("/api/sessions/:id/thread/attachments/:name", (c) => {
    const id = c.req.param("id");
    const r = chat(c, id);
    if ("res" in r) return r.res;
    const img = threadImageByName(d.root, id, c.req.param("name"));
    if (!img) return c.json({ error: "unknown attachment" }, 404);
    return new Response(Bun.file(img.file), {
      headers: { "content-type": img.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" },
    });
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

  /** The agent's reasoning effort from the next message on: `effort` a level, or null for the model default. Allowed
   *  during a run (the running turn keeps its level). 202 once the bridge took it; 400 for a level the model's latest
   *  effort.state does not list; 409 bridge-too-old before 1.7.0, command-failed when the bridge refuses it. */
  app.post("/api/sessions/:id/thread/effort", async (c) => {
    const id = c.req.param("id");
    const r = chat(c, id);
    if ("res" in r) return r.res;
    const body = await c.req.json().catch(() => null);
    const effort = isRecord(body) ? body.effort : undefined;
    // Known levels only (shared/effort.ts); they also pass the bridge's own check, which would drop devd's link.
    if (effort !== null && !isKnownEffort(effort)) {
      return c.json({ error: `effort must be null or one of ${KNOWN_EFFORT_LEVELS.join(", ")}` }, 400);
    }
    const version = d.bridgeVersion(id);
    if (version === null || !versionAtLeast(version, EFFORT_MIN_BRIDGE_VERSION)) {
      return c.json({ error: "bridge-too-old", message: `this session's agent bridge (${version ?? "unknown version"}) cannot change the effort; it needs ${EFFORT_MIN_BRIDGE_VERSION} — recreate the session's container` }, 409);
    }
    const known = r.store.effort();
    if (effort !== null && known?.supported && !known.supported.includes(effort)) {
      const takes = known.supported.length === 0 ? "takes no effort levels" : `takes ${known.supported.join(", ")}`;
      return c.json({ error: "unsupported-effort", message: `${known.model ?? "this model"} ${takes}` }, 400);
    }
    try { await d.links.send(id, { kind: "setEffort", effort }); }
    catch (e) { return commandError(c, e); }
    return c.body(null, 202);
  });

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

  /** Settle and snooze apply to every session, tmux too: 404 unknown, 409 ending. */
  const anySession = (c: Context, id: string): { s: SessionRow } | { res: Response } => {
    const s = getSession(d.db, id);
    if (!s) return { res: c.json({ error: "unknown session" }, 404) };
    if (d.mgr.isEnding(id)) return { res: c.json({ error: "session-ending" }, 409) };
    return { s };
  };
  /** Settle and snooze would hide a question or approval the session waits on: 409 request-open. */
  const requestOpen = (c: Context, s: SessionRow): Response | null =>
    d.inbox.item(s).attention.reason === "request" ? c.json({ error: "request-open", message: REQUEST_OPEN }, 409) : null;
  const noUsage = (c: Context) => c.json({ error: "usage limits are not configured" }, 503);
  /** Each answers the session's new inbox item. */
  app.post("/api/sessions/:id/settle", (c) => {
    const r = anySession(c, c.req.param("id"));
    if ("res" in r) return r.res;
    const open = requestOpen(c, r.s);
    if (open) return open;
    d.inbox.settle(r.s.id, "manual");
    return c.json(d.inbox.item(r.s));
  });
  /** Back into the inbox: ends a settle and a snooze. */
  app.post("/api/sessions/:id/unsettle", (c) => {
    const r = anySession(c, c.req.param("id"));
    if ("res" in r) return r.res;
    d.inbox.unsettle(r.s.id);
    return c.json(d.inbox.item(r.s));
  });
  /** `{until}` (epoch ms, in the future) or `{untilReset: true}`; 409 no-active-limit with the reason when the
   *  session has no active usage limit to wait for. */
  app.post("/api/sessions/:id/snooze", async (c) => {
    const r = anySession(c, c.req.param("id"));
    if ("res" in r) return r.res;
    const body = await c.req.json().catch(() => null);
    const keys = isRecord(body) ? Object.keys(body) : [];
    if (!isRecord(body) || keys.length !== 1 || !(keys[0] === "until" || keys[0] === "untilReset")) {
      return c.json({ error: "body must be {until} or {untilReset: true}" }, 400);
    }
    const open = requestOpen(c, r.s);
    if (open) return open;
    if ("until" in body) {
      const until = body.until;
      if (typeof until !== "number" || !Number.isSafeInteger(until) || until <= d.inbox.now()) {
        return c.json({ error: "until must be a time in the future (epoch ms)" }, 400);
      }
      d.inbox.snooze(r.s.id, until, "time");
      return c.json(d.inbox.item(r.s));
    }
    if (body.untilReset !== true) return c.json({ error: "body must be {until} or {untilReset: true}" }, 400);
    if (!d.untilReset) return noUsage(c);
    const target = d.untilReset(r.s);
    if ("reason" in target) return c.json({ error: "no-active-limit", message: target.reason }, 409);
    d.inbox.snooze(r.s.id, target.resetsAt, "reset");
    return c.json(d.inbox.item(r.s));
  });
  /** For the snooze menu: `{resetsAt}` or `{reason}` why "until the limit resets" is not possible. */
  app.get("/api/sessions/:id/snooze-reset", (c) => {
    const r = anySession(c, c.req.param("id"));
    if ("res" in r) return r.res;
    if (!d.untilReset) return noUsage(c);
    return c.json(d.untilReset(r.s));
  });

  /** Server-sent events: `inbox` (InboxItem, coalesced per session by Inbox), `ping` every 25 s and, with
   *  `?session=<id>`, `thread` (LoggedEvent, `id: <seq>`) and `thread-notice` (a devd notice, ThreadItem with item id
   *  `notice:<n>`, no id) for that chat session only.
   *
   *  Replay contract (dashboard): with `Last-Event-ID: <seq>` (an EventSource reconnect) or `?afterSeq=<seq>` (first
   *  connect after loading the thread at that seq; the header wins when both are present) the stream first sends
   *  ONE `thread-snapshot` event `{afterSeq, snapshot}` with `id: snapshot.lastSeq`, then live `thread` events with
   *  seq > that id, each exactly once. The store keeps state, not raw events: `snapshot({afterSeq})` holds every item
   *  and run changed after that seq as whole rows, which replace the client's copies; pending, background and
   *  native replace wholesale. An effort.state never goes out as a `thread` event: `thread-effort` carries the
   *  store's parsed ThreadEffort (no id), and the snapshot has it as `effort`.
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
          // A devd notice (ThreadStore.addNotice) has no seq of its own: no id, so Last-Event-ID stays the bridge's.
          if (isRecord(data) && "notice" in data) { send(sseFrame("thread-notice", data.notice)); return; }
          const e = data as LoggedEvent;
          // The parsed effort as its own event (no id, like a notice): an app that predates it ignores an event name
          // it does not know, but would show an unknown `thread` event type as a notice in the thread.
          if (e.event.type === "effort.state") {
            if (store) send(sseFrame("thread-effort", store.effort()));
            return;
          }
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
