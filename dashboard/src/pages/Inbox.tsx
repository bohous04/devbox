import { useState } from "react";
import { Link } from "react-router-dom";
import { Ellipsis } from "lucide-react";
import type { InboxItem } from "../../../shared/thread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "../api";
import { AppPage, Chevron, Collapse, EmptyState, RowsSkeleton, Section, StatusDot } from "../components/primitives";
import { agoLabel } from "../format";
import { groupInbox, inboxHref, reasonLabel, snoozeTimes, upsertInbox } from "../inboxView";
import { profileFor } from "../newSession";
import { useNow } from "../store";
import { useEventStream } from "../useEventStream";

const DOT = { needs_you: "waiting", working: "working", idle: "idle", snoozed: "idle", settled: "idle" } as const;

const untilLabel = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Settle, unsettle and snooze. "Until the limit resets" asks devd when the menu opens; it stays disabled with
 *  devd's reason when there is no active limit (or no meter for this agent). */
function RowMenu({ item, onItem }: { item: InboxItem; onItem: (i: InboxItem) => void }) {
  const [reset, setReset] = useState<{ resetsAt: number } | { reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const section = item.attention.section;
  const run = (p: Promise<InboxItem>) => {
    setError(null);
    p.then(onItem, (e: Error) => setError(e.message || "action failed"));
  };
  const open = (o: boolean) => {
    if (!o || section === "settled" || section === "snoozed") return;
    setReset(null);
    api.snoozeReset(item.sessionId).then(setReset, (e: Error) => setReset({ reason: e.message || "could not ask devd" }));
  };
  const t = snoozeTimes(new Date());
  return (
    <span className="flex flex-none flex-col items-end gap-1 pt-2.5 pr-3">
      <DropdownMenu onOpenChange={open}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${item.title}`}><Ellipsis aria-hidden="true" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={16} className="w-64 max-w-[calc(100vw-2rem)]">
          {section === "settled" || section === "snoozed" ? (
            <DropdownMenuItem onSelect={() => run(api.unsettle(item.sessionId))}>Back to the inbox</DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => run(api.settle(item.sessionId))}>Settle</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">Snooze</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => run(api.snooze(item.sessionId, { until: t.hour }))}>1 hour</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(api.snooze(item.sessionId, { until: t.tomorrow }))}>Tomorrow 9:00</DropdownMenuItem>
              <DropdownMenuItem
                disabled={reset === null || "reason" in reset}
                onSelect={() => run(api.snooze(item.sessionId, { untilReset: true }))}
                className="items-start data-[disabled]:opacity-100"
              >
                <span className="flex min-w-0 flex-col">
                  <span className={reset === null || "reason" in reset ? "opacity-50" : undefined}>Until the limit resets</span>
                  <span className="text-xs text-muted-foreground">
                    {reset === null ? "Checking…" : "reason" in reset ? reset.reason : untilLabel(reset.resetsAt)}
                  </span>
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <span role="alert" className="max-w-40 text-right text-xs text-destructive">{error}</span>}
    </span>
  );
}

function Row({ item, now, onItem }: { item: InboxItem; now: number; onItem: (i: InboxItem) => void }) {
  const a = item.attention;
  return (
    <div className="flex min-w-0 items-start">
      <Link to={inboxHref(item)} className="flex min-h-14 min-w-0 flex-1 items-start gap-3 py-3 pl-4 pr-2 transition-colors hover:bg-accent/40">
        <span className="mt-1.5"><StatusDot kind={a.reason === "failed" || a.reason === "rate-limited" || a.reason === "disconnected" || a.reason === "bridge-behind" ? "danger" : DOT[a.section]} pulse={a.section === "working"} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
            <Badge variant="secondary" className="flex-none">{profileFor(item.agent).short}</Badge>
            {item.runtime === "tmux" && <Badge variant="outline" className="flex-none font-mono">tmux</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {/* The repo only when the title does not already say it. */}
            {[a.until === undefined ? "" : `snoozed until ${untilLabel(a.until)}`, reasonLabel(a.reason),
              item.title === `${item.project}/${item.repo}` ? "" : `${item.project}/${item.repo}`].filter(Boolean).join(" · ")}
          </span>
          {item.lastText && <span className="mt-1 block truncate text-xs text-muted-foreground/90">{item.lastText}</span>}
        </span>
        <span className="flex-none pt-0.5 text-xs tabular-nums text-muted-foreground">{a.since > 0 ? agoLabel(now - a.since) : ""}</span>
      </Link>
      <RowMenu item={item} onItem={onItem} />
    </div>
  );
}

function Rows({ items, now, onItem }: { items: InboxItem[]; now: number; onItem: (i: InboxItem) => void }) {
  return <Card className="gap-0 divide-y overflow-hidden p-0">{items.map((i) => <Row key={i.sessionId} item={i} now={now} onItem={onItem} />)}</Card>;
}

/** A section that starts collapsed (Working, Snoozed, Settled). */
function Shelf({ label, items, now, onItem }: { label: string; items: InboxItem[]; now: number; onItem: (i: InboxItem) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Section
      label={`${label} · ${items.length}`}
      meta={items.length > 0 && (
        <button type="button" className="flex min-h-8 items-center gap-1 text-sm text-muted-foreground hover:text-foreground" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Chevron open={open} />{open ? "hide" : "show"}
        </button>
      )}
    >
      <Collapse open={open}><Rows items={items} now={now} onItem={onItem} /></Collapse>
    </Section>
  );
}

/** Every session by what it needs: needs you (an answer, a failure, a finished run you have not seen, a lost
 *  agent), working, idle, then the snoozed and settled shelves. Live over the SSE stream; polled every 5 s while the
 *  stream is down. */
export function Inbox() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const now = useNow(15_000);
  const { paused, pollError, badFrame } = useEventStream({
    enabled: true,
    onInboxList: setItems,
    // Until the first full list arrives a single item would read as the whole inbox.
    onInbox: (item) => setItems((cur) => (cur === null ? cur : upsertInbox(cur, item))),
  });
  const g = items ? groupInbox(items) : null;
  // A row action answers the session's new item: shown at once, the SSE event that follows is the same.
  const onItem = (item: InboxItem) => setItems((cur) => (cur === null ? cur : upsertInbox(cur, item)));

  return (
    <AppPage title="Inbox" sub="Sessions that need you first, then the ones at work.">
      {(paused || badFrame) && (
        <p role="status" className="mb-4 rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {paused ? `live updates paused — refreshing every 5 s${pollError ? ` (last refresh failed: ${pollError})` : ""}` : `live update dropped: ${badFrame}`}
        </p>
      )}
      {!g ? (pollError ? <p role="alert" className="text-sm text-destructive">{pollError}</p> : <RowsSkeleton rows={4} />) : (
        <>
          <Section label={`Needs you · ${g.needsYou.length}`}>
            {g.needsYou.length ? <Rows items={g.needsYou} now={now} onItem={onItem} /> : <EmptyState title="Nothing waiting for you" />}
          </Section>
          <Shelf label="Working" items={g.working} now={now} onItem={onItem} />
          <Section label={`Idle · ${g.idle.length}`}>
            {g.idle.length > 0 && <Rows items={g.idle} now={now} onItem={onItem} />}
          </Section>
          <Shelf label="Snoozed" items={g.snoozed} now={now} onItem={onItem} />
          <Shelf label="Settled" items={g.settled} now={now} onItem={onItem} />
        </>
      )}
    </AppPage>
  );
}
