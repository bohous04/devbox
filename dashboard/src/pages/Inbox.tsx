import { useState } from "react";
import { Link } from "react-router-dom";
import type { InboxItem } from "../../../shared/thread";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { AppPage, Chevron, Collapse, EmptyState, RowsSkeleton, Section, StatusDot } from "../components/primitives";
import { agoLabel } from "../format";
import { groupInbox, inboxHref, reasonLabel, upsertInbox } from "../inboxView";
import { profileFor } from "../newSession";
import { useNow } from "../store";
import { useEventStream } from "../useEventStream";

const DOT = { needs_you: "waiting", working: "working", idle: "idle" } as const;

function Row({ item, now }: { item: InboxItem; now: number }) {
  const a = item.attention;
  return (
    <Link to={inboxHref(item)} className="flex min-h-14 min-w-0 items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/40">
      <span className="mt-1.5"><StatusDot kind={a.reason === "failed" || a.reason === "disconnected" ? "danger" : DOT[a.section]} pulse={a.section === "working"} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
          <Badge variant="secondary" className="flex-none">{profileFor(item.agent).short}</Badge>
          {item.runtime === "tmux" && <Badge variant="outline" className="flex-none font-mono">tmux</Badge>}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {/* The repo only when the title does not already say it. */}
          {[reasonLabel(a.reason), item.title === `${item.project}/${item.repo}` ? "" : `${item.project}/${item.repo}`].filter(Boolean).join(" · ")}
        </span>
        {item.lastText && <span className="mt-1 block truncate text-xs text-muted-foreground/90">{item.lastText}</span>}
      </span>
      <span className="flex-none pt-0.5 text-xs tabular-nums text-muted-foreground">{a.since > 0 ? agoLabel(now - a.since) : ""}</span>
    </Link>
  );
}

function Rows({ items, now }: { items: InboxItem[]; now: number }) {
  return <Card className="gap-0 divide-y overflow-hidden p-0">{items.map((i) => <Row key={i.sessionId} item={i} now={now} />)}</Card>;
}

/** Every session by what it needs: needs you (an answer, a failure, a finished run you have not seen, a lost
 *  agent), working, idle. Live over the SSE stream; polled every 5 s while the stream is down. */
export function Inbox() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [workingOpen, setWorkingOpen] = useState(false);
  const now = useNow(15_000);
  const { paused, pollError } = useEventStream({
    enabled: true,
    onInboxList: setItems,
    // Until the first full list arrives a single item would read as the whole inbox.
    onInbox: (item) => setItems((cur) => (cur === null ? cur : upsertInbox(cur, item))),
  });
  const g = items ? groupInbox(items) : null;

  return (
    <AppPage title="Inbox" sub="Sessions that need you first, then the ones at work.">
      {paused && (
        <p role="status" className="mb-4 rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          live updates paused — refreshing every 5 s{pollError ? ` (last refresh failed: ${pollError})` : ""}
        </p>
      )}
      {!g ? (pollError ? <p role="alert" className="text-sm text-destructive">{pollError}</p> : <RowsSkeleton rows={4} />) : (
        <>
          <Section label={`Needs you · ${g.needsYou.length}`}>
            {g.needsYou.length ? <Rows items={g.needsYou} now={now} /> : <EmptyState title="Nothing waiting for you" />}
          </Section>
          <Section
            label={`Working · ${g.working.length}`}
            meta={g.working.length > 0 && (
              <button type="button" className="flex min-h-8 items-center gap-1 text-sm text-muted-foreground hover:text-foreground" aria-expanded={workingOpen} onClick={() => setWorkingOpen((o) => !o)}>
                <Chevron open={workingOpen} />{workingOpen ? "hide" : "show"}
              </button>
            )}
          >
            <Collapse open={workingOpen}><Rows items={g.working} now={now} /></Collapse>
          </Section>
          <Section label={`Idle · ${g.idle.length}`}>
            {g.idle.length > 0 && <Rows items={g.idle} now={now} />}
          </Section>
        </>
      )}
    </AppPage>
  );
}
