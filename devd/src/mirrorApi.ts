import type { Context, Hono } from "hono";
import type { MirrorResponse } from "../../shared/mirror";
import type { LoggedEvent } from "../../shared/thread";
import { SSE_PING_MS, sseFrame } from "./threadApi";
import type { ThreadStore } from "./threadStore";
import { MirrorSendRefused, type TranscriptMirror } from "./transcriptMirror";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function nonNegInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The Chat view of a tmux session (transcriptMirror.ts). Additive: `/thread` keeps answering 409 not-a-chat-session
 *  for tmux sessions, so clients that predate the mirror are unchanged.
 *  - `GET /api/sessions/:id/mirror` (afterSeq, beforeSeq, limit as for `/thread`) → MirrorResponse;
 *  - `GET /api/sessions/:id/mirror/stream`: the `/api/stream?session=` contract for the mirror's store (`thread-snapshot`
 *    on Last-Event-ID/afterSeq, then `thread` and `thread-notice`), plus `mirror` events with the MirrorInfo;
 *  - `POST /api/sessions/:id/mirror/messages` {text} → 202, 400 (a command, an empty text), 409 {error, message}. */
export function registerMirrorRoutes(app: Hono, mirror: TranscriptMirror): void {
  const session = (c: Context, id: string): Response | null => {
    const r = mirror.session(id);
    if (!("error" in r)) return null;
    return c.json({ error: r.error }, r.error === "unknown-session" ? 404 : 409);
  };

  /** store() refuses a session that started ending after the check above: the same 409 as session(). */
  const openStore = (c: Context, id: string): ThreadStore | Response => {
    try { return mirror.store(id); }
    catch (e) {
      if ("error" in mirror.session(id)) return session(c, id)!;
      throw e;
    }
  };

  app.get("/api/sessions/:id/mirror", async (c) => {
    const id = c.req.param("id");
    const bad = session(c, id);
    if (bad) return bad;
    const opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {};
    for (const key of ["afterSeq", "beforeSeq", "limit"] as const) {
      const raw = c.req.query(key);
      if (raw === undefined) continue;
      const n = nonNegInt(raw);
      if (n === null) return c.json({ error: `${key} must be a non-negative integer` }, 400);
      opts[key] = n;
    }
    await mirror.refresh(id);
    // The session may have started ending while the pane was read.
    const after = session(c, id);
    if (after) return after;
    const store = openStore(c, id);
    if (store instanceof Response) return store;
    return c.json({ snapshot: store.snapshot(opts), mirror: mirror.info(id) } satisfies MirrorResponse);
  });

  app.post("/api/sessions/:id/mirror/messages", async (c) => {
    const id = c.req.param("id");
    const bad = session(c, id);
    if (bad) return bad;
    const body = await c.req.json().catch(() => null);
    if (!isRecord(body) || Object.keys(body).some((k) => k !== "text") || typeof body.text !== "string") {
      return c.json({ error: "body must be {text}" }, 400);
    }
    try { await mirror.send(id, body.text); }
    catch (e) {
      if (!(e instanceof MirrorSendRefused)) throw e;
      return e.status === 400 ? c.json({ error: e.message }, 400) : c.json({ error: e.code, message: e.message }, e.status);
    }
    return c.json({ sent: true }, 202);
  });

  app.get("/api/sessions/:id/mirror/stream", (c) => {
    const id = c.req.param("id");
    const bad = session(c, id);
    if (bad) return bad;
    let replayAfter: number | null = null;
    for (const [what, raw] of [["Last-Event-ID", c.req.header("last-event-id")], ["afterSeq", c.req.query("afterSeq")]] as const) {
      if (raw === undefined) continue;
      const n = nonNegInt(raw);
      if (n === null) return c.json({ error: `${what} must be a non-negative integer` }, 400);
      replayAfter ??= n; // the header (checked first) wins
    }
    const store = openStore(c, id);
    if (store instanceof Response) return store;
    const enc = new TextEncoder();
    let stop = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        let closed = false;
        const send = (s: string) => {
          if (closed) return;
          try { ctrl.enqueue(enc.encode(s)); }
          catch { stop(); }
        };
        let sentSeq = -1;
        // Subscribed BEFORE the store is read, so nothing published in between is lost.
        const unsubscribe = mirror.subscribe(id, (data) => {
          if (isRecord(data) && "notice" in data) { send(sseFrame("thread-notice", data.notice)); return; }
          if (isRecord(data) && "mirror" in data) { send(sseFrame("mirror", data.mirror)); return; }
          // The session stopped or ended: close, so the client reconnects (and gets a 409/404 or a fresh poller).
          if (isRecord(data) && "released" in data) { stop(); try { ctrl.close(); } catch { /* already closed */ } return; }
          const e = data as LoggedEvent;
          if (e.seq <= sentSeq) return;
          sentSeq = e.seq;
          send(sseFrame("thread", e, e.seq));
        });
        const unwatch = mirror.watch(id);
        const ping = setInterval(() => send(sseFrame("ping", {})), SSE_PING_MS);
        stop = () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsubscribe();
          unwatch();
        };
        c.req.raw.signal.addEventListener("abort", stop);
        send(": open\n\n");
        if (replayAfter !== null) {
          const snapshot = store.snapshot({ afterSeq: replayAfter });
          sentSeq = Math.max(sentSeq, snapshot.lastSeq);
          send(sseFrame("thread-snapshot", { afterSeq: replayAfter, snapshot }, snapshot.lastSeq));
        }
        send(sseFrame("mirror", mirror.info(id)));
        void mirror.refresh(id);
      },
      cancel() { stop(); },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
    });
  });
}
