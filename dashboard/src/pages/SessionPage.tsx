import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";
import type { ThreadSnapshot } from "../../../shared/thread";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, ApiError } from "../api";
import { Composer } from "../components/chat/Composer";
import { MessageList } from "../components/chat/MessageList";
import { Switchers } from "../components/chat/Switchers";
import { EmptyState, RowsSkeleton } from "../components/primitives";
import { profileFor } from "../newSession";
import { useStore } from "../store";
import { terminalTabUrl } from "../terminalRoute";
import { activeRun, applyNotice, applyThreadEvent, criticRunIds, mergeSnapshot, queuedRunIds } from "../threadView";
import { useEventStream } from "../useEventStream";

// Same lazy import as TerminalPage: xterm stays in its own chunk.
const Terminal = lazy(() => import("../components/Terminal").then((m) => ({ default: m.Terminal })));

/** The newest seq at which a run ended: reaching it while the page is open counts as seen. */
const lastEndedSeq = (t: ThreadSnapshot) => Math.max(0, ...t.runs.map((r) => r.endedSeq ?? 0));

function ChatPage({ id }: { id: string }) {
  const { live } = useStore();
  const session = live?.sessions.find((s) => s.id === id);
  const [thread, setThread] = useState<ThreadSnapshot | null>(null);
  const [loadErr, setLoadErr] = useState<{ status: number; message: string } | null>(null);
  const [seenErr, setSeenErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "terminal">("chat");
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const bottom = useRef<HTMLDivElement | null>(null);
  // Set by the New session dialog (openedNotice), e.g. a pull conflict the agent was asked to resolve.
  const notice = (useLocation().state as { notice?: string | null } | null)?.notice ?? null;

  useEffect(() => {
    let alive = true;
    setThread(null); setLoadErr(null);
    api.thread(id).then(
      (t) => { if (alive) setThread(t); },
      (e) => { if (alive) setLoadErr({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }); },
    );
    return () => { alive = false; };
  }, [id]);

  const { paused, badFrame } = useEventStream({
    sessionId: id,
    enabled: thread !== null,
    afterSeq: () => threadRef.current!.lastSeq,
    onSnapshot: (m) => setThread((t) => (t ? mergeSnapshot(t, m) : t)),
    onThread: (e) => setThread((t) => (t ? applyThreadEvent(t, e) : t)),
    onNotice: (item) => setThread((t) => (t ? applyNotice(t, item) : t)),
  });

  // Opening the page marks the thread seen; so does a run ending while the user looks at it, and coming back to
  // the tab.
  const loaded = thread !== null;
  const ended = thread ? lastEndedSeq(thread) : 0;
  useEffect(() => {
    const markSeen = () => {
      const t = threadRef.current;
      if (!t || t.lastSeq <= t.seenSeq || document.visibilityState !== "visible") return;
      api.markSeen(id, t.lastSeq).then(() => setSeenErr(null), (e) => setSeenErr((e as Error).message));
    };
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => document.removeEventListener("visibilitychange", markSeen);
  }, [id, loaded, ended]);

  // Follow the conversation while the user is at its end (any change: text, tool output, a resolved request);
  // leave them alone when they scrolled up.
  const lastSeq = thread?.lastSeq ?? 0;
  const atEnd = useRef(true);
  useEffect(() => {
    const onScroll = () => { atEnd.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (atEnd.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [lastSeq]);

  useEffect(() => { document.title = `devbox · ${session?.name?.trim() || id}`; }, [id, session?.name]);

  const running = thread ? activeRun(thread) !== undefined : false;
  const title = session?.name?.trim() || (session ? `${session.project}/${session.repo}` : id);

  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col">
      <header className="mb-4 flex flex-col gap-3">
        <Link to="/" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" aria-hidden="true" />Inbox</Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {session && <Badge variant="secondary">{profileFor(session.agent).short}</Badge>}
          {running && <Badge variant="outline">running</Badge>}
          <span className="flex-1" />
          <Tabs value={tab} onValueChange={(v) => setTab(v as "chat" | "terminal")}>
            <TabsList>
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      {tab === "terminal" && (
        <Suspense fallback={null}>
          <Terminal id={id} tmux="main" title={title} onClose={() => setTab("chat")} />
        </Suspense>
      )}

      {(paused || badFrame) && (
        <p role="status" className="mb-3 rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {paused ? "live updates paused — reconnecting" : `live update dropped: ${badFrame} — reload to catch up`}
        </p>
      )}
      {notice && <p role="status" className="mb-3 text-sm text-muted-foreground">{notice}</p>}
      {seenErr && <p role="alert" className="mb-3 text-sm text-destructive">could not mark the thread as seen: {seenErr}</p>}

      {loadErr ? (
        loadErr.message === "not-a-chat-session"
          ? <EmptyState title="This is a tmux session" hint="It has no chat thread; its agent runs in the terminal." action={<a className="text-sm underline" href={terminalTabUrl(id)}>Open the terminal</a>} />
          : <p role="alert" className="text-sm text-destructive">Could not load the thread: {loadErr.message}</p>
      ) : !thread ? (
        <RowsSkeleton rows={4} />
      ) : (
        <>
          <div className="flex-1">
            {thread.items.length === 0
              ? <EmptyState title="No messages yet" hint="Write the first message below." />
              : <MessageList sessionId={id} items={thread.items} pending={thread.pending} queued={queuedRunIds(thread)} critic={criticRunIds(thread)} onAnswer={(rid, a) => api.answerRequest(id, rid, a)} />}
            {thread.background.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">background: {thread.background.map((b) => b.label).join(", ")}</p>
            )}
            <div ref={bottom} />
          </div>
          {/* Above the mobile bottom bar (h-16); from lg there is none. The transcript fades into the dock in the strip
              above it; in dark the dock is a faintly tinted band (one floor for the box), in light the page itself.
              The negative bottom margin cancels main's bottom padding (App.tsx pb-24 / lg:pb-10), which would otherwise
              leave a gap under the dock at the end of the thread. */}
          <div className="sticky bottom-16 z-10 -mx-4 -mb-8 mt-8 bg-[var(--dock)] px-4 pb-3 pt-3 [--dock:var(--background)] before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-[var(--dock)] before:to-transparent sm:-mx-6 sm:px-6 lg:bottom-0 lg:-mx-10 lg:-mb-10 lg:px-10 lg:pb-5 dark:[--dock:color-mix(in_oklab,var(--muted)_35%,var(--background))]">
            <div className="mx-auto w-full max-w-[42rem]">
              <Switchers sessionId={id} thread={thread}>
                {({ menus, status }) => (
                  <Composer
                    running={running} onStop={() => api.interrupt(id)}
                    onSend={async (text, images) => {
                      const paths: string[] = [];
                      for (const image of images) paths.push((await api.uploadThreadImage(id, image)).path);
                      await api.sendMessage(id, text, paths);
                    }}
                    controls={menus} notices={status}
                  />
                )}
              </Switchers>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Route /s/:id — a chat session: its conversation, and the tmux terminal of the same container as a tab. */
export function SessionPage() {
  const { id } = useParams();
  if (!id) return null; // the router does not route here without :id, this is just for the types
  return <ChatPage key={id} id={id} />;
}
