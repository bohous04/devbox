import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { EndedRemoved } from "../../shared/ended";
import { endedImagesDir, getEnded, hideEnded, listEnded, openTranscript, toEnded, type EndedRow } from "./endedSessions";
import type { EventBus } from "./eventBus";
import { imageInDir } from "./threadImages";

export interface EndedApiDeps { db: Database; bus: EventBus; now?: () => number }

/** A non-negative integer from a query value; null when it is anything else. */
function nonNegInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Ended sessions' transcripts (endedSessions.ts): the list, a read-only snapshot, its images and hiding one.
 *  `POST /api/ended/:id/continue` is in api.ts, next to the session open it shares. */
export function registerEndedRoutes(app: Hono, d: EndedApiDeps): void {
  const row = (c: Context): EndedRow | Response => getEnded(d.db, c.req.param("id")!) ?? c.json({ error: "unknown ended session" }, 404);

  app.get("/api/ended", (c) => c.json({ items: listEnded(d.db) }));

  /** One transcript's EndedSession, a hidden one too (the transcript page opened from a link). */
  app.get("/api/ended/:id", (c) => {
    const r = row(c);
    return r instanceof Response ? r : c.json(toEnded(r));
  });

  /** The same ThreadSnapshot as GET /api/sessions/:id/thread, with the same paging. */
  app.get("/api/ended/:id/transcript", (c) => {
    const r = row(c);
    if (r instanceof Response) return r;
    const opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {};
    for (const key of ["afterSeq", "beforeSeq", "limit"] as const) {
      const raw = c.req.query(key);
      if (raw === undefined) continue;
      const n = nonNegInt(raw);
      if (n === null) return c.json({ error: `${key} must be a non-negative integer` }, 400);
      opts[key] = n;
    }
    const store = openTranscript(r);
    try { return c.json(store.snapshot(opts)); } finally { store.close(); }
  });

  // The transcript's images by the name in their `/inbox/<session>/<name>` path; uuid names, cached for good.
  app.get("/api/ended/:id/attachments/:name", (c) => {
    const r = row(c);
    if (r instanceof Response) return r;
    const img = imageInDir(endedImagesDir(r), c.req.param("name"));
    if (!img) return c.json({ error: "unknown attachment" }, 404);
    return new Response(Bun.file(img.file), {
      headers: { "content-type": img.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" },
    });
  });

  /** Out of the inbox for good (an ended transcript is never unsettled); it is still purged on schedule. */
  app.post("/api/ended/:id/hide", (c) => {
    const r = row(c);
    if (r instanceof Response) return r;
    if (hideEnded(d.db, r.id, d.now?.() ?? Date.now())) {
      const removed: EndedRemoved = { id: r.id, removed: true };
      d.bus.publish("inbox-ended", removed);
    }
    return c.body(null, 204);
  });
}
