import { useEffect, useRef, useState } from "react";
import type { MirrorInfo } from "../../shared/mirror";
import type { AgentCommand, InboxItem, InboxRemoved, LoggedEvent, ThreadEffort, ThreadItem, ThreadSnapshot } from "../../shared/thread";
import type { EndedRemoved, EndedSession } from "../../shared/ended";
import { api } from "./api";

export const STREAM_POLL_MS = 5000;

/** The stream's URL: `/api/stream` (with `?session=` for a chat session's thread), or a tmux session's mirror stream. */
export function streamUrl(sessionId: string | undefined, mirror: boolean, afterSeq: number | undefined): string {
  const q = new URLSearchParams();
  const mirrored = mirror && sessionId !== undefined;
  if (sessionId !== undefined) {
    if (!mirrored) q.set("session", sessionId);
    if (afterSeq !== undefined) q.set("afterSeq", String(afterSeq));
  }
  const qs = q.toString();
  const base = mirrored ? `/api/sessions/${encodeURIComponent(sessionId)}/mirror/stream` : "/api/stream";
  return `${base}${qs ? `?${qs}` : ""}`;
}

export interface EventStreamOptions {
  /** With a session: also that chat session's thread events (`?session=`). */
  sessionId?: string;
  /** With a session: its transcript mirror's stream (a tmux session's Chat view) instead of `/api/stream`. It sends
   *  the same thread events, plus `mirror` (onMirror), and no inbox events. */
  mirror?: boolean;
  onMirror?: (info: MirrorInfo) => void;
  /** False until the caller has what the stream needs (the loaded thread); nothing connects before. */
  enabled: boolean;
  /** The seq of the thread the caller holds, sent as `afterSeq` on a fresh connect. An EventSource reconnect
   *  sends `Last-Event-ID` itself (and devd prefers it). */
  afterSeq?: () => number;
  onSnapshot?: (m: { afterSeq: number; snapshot: ThreadSnapshot }) => void;
  onThread?: (e: LoggedEvent) => void;
  /** A notice devd added (switch, resume failed…): no seq of its own, see applyNotice. */
  onNotice?: (item: ThreadItem) => void;
  /** The agent's reasoning effort changed (devd's parsed ThreadEffort): no seq of its own, see applyEffort. */
  onEffort?: (effort: ThreadEffort | null) => void;
  /** The current harness's slash commands changed (null: it runs none): no seq of its own, see applyCommands. */
  onCommands?: (commands: AgentCommand[] | null) => void;
  onInbox?: (item: InboxItem | InboxRemoved) => void;
  /** The whole inbox: fetched when the stream (re)opens and every 5 s while it is down. */
  onInboxList?: (items: InboxItem[]) => void;
  /** An ended session's transcript that was just kept, or one hidden or purged (SSE `inbox-ended`). */
  onEnded?: (e: EndedSession | EndedRemoved) => void;
  /** All ended transcripts: fetched like the inbox list. */
  onEndedList?: (items: EndedSession[]) => void;
  /** Why the last fetch of the ended transcripts failed, null once one succeeded. Separate from `pollError`: the stream
   *  may be up while that list did not load. */
  onEndedError?: (error: string | null) => void;
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
  const { sessionId, enabled, mirror } = opts;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const loadInbox = () => {
      if (h.current.onEndedList) {
        api.ended().then(
          (r) => { if (!disposed) { h.current.onEndedError?.(null); h.current.onEndedList?.(r.items); } },
          (e) => { if (!disposed) h.current.onEndedError?.((e as Error).message); },
        );
      }
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
      const src = new EventSource(streamUrl(sessionId, mirror === true, sessionId !== undefined ? h.current.afterSeq?.() : undefined));
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
      on<ThreadItem>("thread-notice", (d) => h.current.onNotice?.(d));
      on<ThreadEffort | null>("thread-effort", (d) => h.current.onEffort?.(d));
      on<AgentCommand[] | null>("thread-commands", (d) => h.current.onCommands?.(d));
      on<InboxItem | InboxRemoved>("inbox", (d) => h.current.onInbox?.(d));
      on<EndedSession | EndedRemoved>("inbox-ended", (d) => h.current.onEnded?.(d));
      on<MirrorInfo>("mirror", (d) => h.current.onMirror?.(d));
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
  }, [sessionId, enabled, mirror]);

  return { paused, pollError, badFrame };
}
