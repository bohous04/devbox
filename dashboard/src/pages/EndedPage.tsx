import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { EndedSession } from "../../../shared/ended";
import { isHousekeepingNotice, type ThreadSnapshot } from "../../../shared/thread";
import { Button } from "@/components/ui/button";
import { api } from "../api";
import { MessageList } from "../components/chat/MessageList";
import { OlderItems } from "../components/chat/OlderItems";
import { EmptyState, RowsSkeleton } from "../components/primitives";
import { canContinue, continueInFlight, continueLabel, continueOnce, endedTitle, transcriptNote } from "../endedView";
import { criticRunIds, emptyHeld, hasOlderThan, olderBeforeSeq, prependOlder, tailView, THREAD_PAGE } from "../threadView";

const NOTHING_QUEUED = new Set<string>();
const noAnswer = async () => { throw new Error("a transcript takes no answers"); };

/** An ended session's transcript, read-only: the conversation as the session page showed it and, in the composer's
 *  place, one line and the button that continues the work in a new session. */
function Transcript({ id }: { id: string }) {
  const navigate = useNavigate();
  const [ended, setEnded] = useState<EndedSession | null>(null);
  const [thread, setThread] = useState<ThreadSnapshot | null>(null);
  // Only the newest THREAD_PAGE items are loaded at first; true while older ones may be left (OlderItems).
  const [more, setMore] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // A continue started before this page was (re)opened is still running: the button waits for it.
  const [starting, setStarting] = useState(() => continueInFlight(id));
  const [startErr, setStartErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.endedSession(id).then(
      // A transcript the session ended without has nothing to fetch (devd answers 410).
      (e) => (e.transcript === "missing" ? Promise.resolve(null) : api.endedTranscript(id, { limit: THREAD_PAGE })).then((t) => {
        if (alive) { setEnded(e); setThread(t ?? { lastSeq: 0, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: null, effort: null }); setMore(t !== null && hasOlderThan(t)); }
      }),
    ).catch((e) => { if (alive) setLoadErr((e as Error).message); });
    return () => { alive = false; };
  }, [id]);
  // Joins a continue still running from an earlier visit, then opens its session.
  useEffect(() => {
    if (!continueInFlight(id)) return;
    let alive = true;
    continueOnce(id, api.continueEnded).then(
      (r) => { if (alive) navigate(`/s/${encodeURIComponent(r.sessionId)}`); },
      (e) => { if (alive) { setStarting(false); setStartErr((e as Error).message); } },
    );
    return () => { alive = false; };
  }, [id, navigate]);

  const loadOlder = async () => {
    const beforeSeq = thread ? olderBeforeSeq(thread) : null;
    if (beforeSeq === null) { setMore(false); return; }
    const page = await api.endedTranscript(id, { beforeSeq, limit: THREAD_PAGE });
    // A transcript gets no live updates: nothing is held.
    setThread((cur) => (cur ? prependOlder(cur, page.items, emptyHeld(), hasOlderThan(page)) : cur));
    setMore(hasOlderThan(page));
  };
  const view = thread ? tailView(thread.items.filter((i) => !isHousekeepingNotice(i)), more) : null;

  const title = ended ? endedTitle(ended) : null;
  useEffect(() => { document.title = `devbox · ${title ?? id}`; }, [id, title]);

  const start = () => {
    setStarting(true);
    setStartErr(null);
    continueOnce(id, api.continueEnded).then(
      (r) => navigate(`/s/${encodeURIComponent(r.sessionId)}`),
      (e) => { setStarting(false); setStartErr((e as Error).message); },
    );
  };

  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col">
      <header className="sticky top-0 z-20 -mx-4 -mt-6 mb-6 flex min-h-14 min-w-0 items-center gap-2 border-b border-border bg-background px-4 py-2 sm:-mx-6 sm:px-6 lg:-mx-10 lg:-mt-8 lg:px-10 lg:py-3">
        <Link to="/" aria-label="Back to Inbox" title="Inbox"
          className="-ml-1.5 grid size-8 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {ended && (
            <>
              <span className="hidden flex-none truncate text-sm text-muted-foreground sm:inline">{ended.project} / {ended.repo}</span>
              <span className="hidden text-muted-foreground/50 sm:inline" aria-hidden="true">/</span>
            </>
          )}
          <h1 className="min-w-0 truncate text-sm font-medium text-foreground">{title ?? id}</h1>
        </div>
        <span className="flex-none rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">Ended</span>
      </header>

      {loadErr ? (
        <p role="alert" className="text-sm text-destructive">Could not load the transcript: {loadErr}</p>
      ) : !thread || !ended ? (
        <RowsSkeleton rows={4} />
      ) : (
        <>
          <div className="mx-auto w-full max-w-[42rem] flex-1">
            {transcriptNote(ended.transcript) !== null && (
              <p className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{transcriptNote(ended.transcript)}</p>
            )}
            {ended.transcript === "missing" ? null : thread.items.length === 0
              ? <EmptyState title="No messages" hint="The session ended before anything was said." />
              : <>
                <OlderItems firstSeq={thread.items[0]?.seq} more={more} load={loadOlder} />
                <MessageList sessionId={ended.sessionId} endedId={ended.id} items={view!.items} partialRun={view!.partialRun} runs={thread.runs} pending={[]}
                  queued={NOTHING_QUEUED} critic={criticRunIds(thread)} onAnswer={noAnswer} />
              </>}
          </div>
          <div className="sticky bottom-16 z-10 -mx-4 -mb-8 mt-8 bg-[var(--dock)] px-4 pb-3 pt-3 [--dock:var(--background)] before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-[var(--dock)] before:to-transparent sm:-mx-6 sm:px-6 lg:bottom-0 lg:-mx-10 lg:-mb-10 lg:px-10 lg:pb-5 dark:[--dock:color-mix(in_oklab,var(--muted)_35%,var(--background))]">
            <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-2 rounded-xl border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">This is only a transcript.</p>
              {canContinue(ended) && (
                <Button type="button" className="flex-none" disabled={starting} onClick={start}>
                  {starting ? "Starting…" : continueLabel(ended.continueMode)}
                </Button>
              )}
            </div>
            {startErr && <p role="alert" className="mx-auto mt-2 w-full max-w-[42rem] text-sm text-destructive">Could not start the new session: {startErr}</p>}
          </div>
        </>
      )}
    </div>
  );
}

/** Route /ended/:id: an ended session's transcript (devd/src/endedApi.ts). */
export function EndedPage() {
  const { id } = useParams();
  if (!id) return null;
  return <Transcript key={id} id={id} />;
}
