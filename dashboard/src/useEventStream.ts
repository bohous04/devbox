import { useEffect, useRef, useState } from "react";
import type { InboxItem, InboxRemoved, LoggedEvent, ThreadSnapshot } from "../../shared/thread";
import { api } from "./api";

export const STREAM_POLL_MS = 5000;

export interface EventStreamOptions {
  /** With a session: also that chat session's thread events (`?session=`). */
  sessionId?: string;
  /** False until the caller has what the stream needs (the loaded thread); nothing connects before. */
  enabled: boolean;
  /** The seq of the thread the caller holds, sent as `afterSeq` on a fresh connect. An EventSource reconnect
   *  sends `Last-Event-ID` itself (and devd prefers it). */
  afterSeq?: () => number;
  onSnapshot?: (m: { afterSeq: number; snapshot: ThreadSnapshot }) => void;
  onThread?: (e: LoggedEvent) => void;
  onInbox?: (item: InboxItem | InboxRemoved) => void;
  /** The whole inbox: fetched when the stream (re)opens and every 5 s while it is down. */
  onInboxList?: (items: InboxItem[]) => void;
}

/** devd's SSE stream (`GET /api/stream`, devd/src/threadApi.ts). `paused` is true while it is down; then the inbox
 *  is polled every 5 s instead (`pollError` = the last poll failed, with why). A stream devd closed for good
 *  (an error response) is reopened after 5 s with the caller's current `afterSeq`. */
/** `badFrame` = the last stream frame that could not be read (logged too); the frame is dropped, so the view may be
 *  missing that update until the next reload. */
export function useEventStream(opts: EventStreamOptions): { paused: boolean; pollError: string | null; badFrame: string | null } {
  const h = useRef(opts);
  h.current = opts;
  const [paused, setPaused] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [badFrame, setBadFrame] = useState<string | null>(null);
  const { sessionId, enabled } = opts;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const loadInbox = () => {
      if (!h.current.onInboxList) return;
      api.inbox().then(
        (r) => { if (!disposed) { setPollError(null); h.current.onInboxList?.(r.items); } },
        (e) => { if (!disposed) setPollError((e as Error).message); },
      );
    };
    const startPoll = () => {
      if (poll !== undefined) return;
      loadInbox();
      poll = setInterval(loadInbox, STREAM_POLL_MS);
    };
    const stopPoll = () => { clearInterval(poll); poll = undefined; };

    const connect = () => {
      const q = new URLSearchParams();
      if (sessionId !== undefined) {
        q.set("session", sessionId);
        const after = h.current.afterSeq?.();
        if (after !== undefined) q.set("afterSeq", String(after));
      }
      const qs = q.toString();
      const src = new EventSource(`/api/stream${qs ? `?${qs}` : ""}`);
      es = src;
      src.onopen = () => { setPaused(false); stopPoll(); loadInbox(); };
      const on = <T>(type: string, handle: (data: T) => void) => src.addEventListener(type, (m) => {
        let data: T;
        try { data = JSON.parse((m as MessageEvent).data); }
        catch (e) {
          console.error(`event stream: unreadable ${type} frame`, e);
          setBadFrame(`unreadable ${type} update: ${(e as Error).message}`);
          return;
        }
        handle(data);
      });
      on<{ afterSeq: number; snapshot: ThreadSnapshot }>("thread-snapshot", (d) => h.current.onSnapshot?.(d));
      on<LoggedEvent>("thread", (d) => h.current.onThread?.(d));
      on<InboxItem | InboxRemoved>("inbox", (d) => h.current.onInbox?.(d));
      src.onerror = () => {
        if (disposed) return;
        setPaused(true);
        startPoll();
        // CONNECTING = the browser retries by itself (with Last-Event-ID); CLOSED = it gave up.
        if (src.readyState === EventSource.CLOSED) {
          src.close();
          retry = setTimeout(connect, STREAM_POLL_MS);
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      es?.close();
      clearTimeout(retry);
      stopPoll();
      setPaused(false);
    };
  }, [sessionId, enabled]);

  return { paused, pollError, badFrame };
}
