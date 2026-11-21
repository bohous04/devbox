import { useState } from "react";
import { Link } from "react-router-dom";
import { AlarmClock, CircleAlert, CircleCheck, Ellipsis, LoaderCircle, MessageCircleQuestion } from "lucide-react";
import type { InboxItem } from "../../../shared/thread";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "../api";
import { AppPage, Chevron, Collapse, RowsSkeleton } from "../components/primitives";
import { agoLabel } from "../format";
import { groupInbox, inboxHref, plainPreview, projectBadge, reasonLabel, rowTitle, shelfBlock, snoozeTimes, statusParts, splitNeedsYou, upsertInbox, type StatusTone } from "../inboxView";
import { cn } from "@/lib/utils";
import { profileFor } from "../newSession";
import { useNow } from "../store";
import { useEventStream } from "../useEventStream";

const untilLabel = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Settle, unsettle and snooze. "Until the limit resets" asks devd when the menu opens; it stays disabled with
 *  devd's reason when there is no active limit (or no meter for this agent). */
function RowMenu({ item, label, onItem, setError }: {
  item: InboxItem; label: string; onItem: (i: InboxItem) => void; setError: (e: string | null) => void;
}) {
  const [reset, setReset] = useState<{ resetsAt: number } | { reason: string } | null>(null);
  const section = item.attention.section;
  const run = (p: Promise<InboxItem>) => {
    setError(null);
    p.then(onItem, (e: Error) => setError(e.message || "action failed"));
  };
  const blocked = shelfBlock(item);
  const open = (o: boolean) => {
    if (!o || section === "settled" || section === "snoozed" || blocked !== null) return;
    setReset(null);
    api.snoozeReset(item.sessionId).then(setReset, (e: Error) => setReset({ reason: e.message || "could not ask devd" }));
  };
  const t = snoozeTimes(new Date());
  return (
    <span className="flex flex-none py-2 pr-1.5 [@media(hover:hover)]:absolute [@media(hover:hover)]:right-1.5 [@media(hover:hover)]:top-0 [@media(hover:hover)]:pr-0">
      <DropdownMenu onOpenChange={open}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`}
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 group-has-[a:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100"><Ellipsis aria-hidden="true" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={16} className="w-64 max-w-[calc(100vw-2rem)]">
          {section === "settled" || section === "snoozed" ? (
            <DropdownMenuItem onSelect={() => run(api.unsettle(item.sessionId))}>Back to the inbox</DropdownMenuItem>
          ) : (
            <>
              {blocked && <p className="px-2 py-1.5 text-xs text-muted-foreground">{blocked}</p>}
              <DropdownMenuItem disabled={blocked !== null} onSelect={() => run(api.settle(item.sessionId))}>Settle</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">Snooze</DropdownMenuLabel>
              <DropdownMenuItem disabled={blocked !== null} onSelect={() => run(api.snooze(item.sessionId, { until: t.hour }))}>1 hour</DropdownMenuItem>
              <DropdownMenuItem disabled={blocked !== null} onSelect={() => run(api.snooze(item.sessionId, { until: t.morning.at }))}>{t.morning.label}</DropdownMenuItem>
              <DropdownMenuItem
                disabled={blocked !== null || reset === null || "reason" in reset}
                onSelect={() => run(api.snooze(item.sessionId, { untilReset: true }))}
                className="items-start data-[disabled]:opacity-100"
              >
                <span className="flex min-w-0 flex-col">
                  <span className={blocked !== null || reset === null || "reason" in reset ? "opacity-50" : undefined}>Until the limit resets</span>
                  <span className="text-xs text-muted-foreground">
                    {blocked !== null ? "" : reset === null ? "Checking…" : "reason" in reset ? reset.reason : untilLabel(reset.resetsAt)}
                  </span>
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

const BADGE = [
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  "bg-violet-500/15 text-violet-800 dark:text-violet-300",
  "bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-300",
];

const TONE: Record<StatusTone, string> = {
  action: "text-amber-700 dark:text-amber-300",
  danger: "text-red-600 dark:text-red-400",
  done: "text-muted-foreground [&>svg]:text-emerald-600 dark:[&>svg]:text-emerald-400",
  busy: "text-sky-700 dark:text-sky-300",
  quiet: "text-muted-foreground",
};

function ToneIcon({ tone }: { tone: StatusTone }) {
  const c = "size-3.5 flex-none";
  if (tone === "action") return <MessageCircleQuestion className={c} aria-hidden="true" />;
  if (tone === "danger") return <CircleAlert className={c} aria-hidden="true" />;
  if (tone === "done") return <CircleCheck className={c} aria-hidden="true" />;
  if (tone === "busy") return <LoaderCircle className={cn(c, "animate-spin [animation-duration:2s] motion-reduce:animate-none")} aria-hidden="true" />;
  return <AlarmClock className={c} aria-hidden="true" />;
}

/** The row's state next to its project. `compact` (Finished, Idle, shelves): only the outcome mark and the time, since
 *  the group heading already says the state; the full reason stays in the tooltip and for screen readers. */
function Status({ item, now, parts }: { item: InboxItem; now: number; parts: NonNullable<ReturnType<typeof statusParts>> }) {
  const a = item.attention;
  const st = parts.mark;
  const when = parts.until !== null ? `until ${untilLabel(parts.until)}` : parts.ago;
  const full = [reasonLabel(a.reason), a.since > 0 ? agoLabel(now - a.since) : ""].filter(Boolean).join(" · ");
  return (
    <span className={cn("flex flex-none items-center gap-1 tabular-nums", st && TONE[st.tone], parts.showLabel && "font-medium")} title={full || undefined}>
      {st && <ToneIcon tone={st.tone} />}
      {st && <span className={parts.showLabel ? undefined : "sr-only"}>{st.label}</span>}
      {when && <span className={cn("font-normal", st ? "opacity-75" : "text-muted-foreground")}>{when}</span>}
    </span>
  );
}

const Dot = () => <span className="flex-none opacity-50" aria-hidden="true">·</span>;

/** One fixed shape per group: a meta line (project, state, time, agent), the title, and in groups where the latest
 *  message is the point (Needs you, Working, Snoozed) a dimmer preview line. */
function Row({ item, now, onItem, preview }: { item: InboxItem; now: number; onItem: (i: InboxItem) => void; preview: boolean }) {
  const a = item.attention;
  const badge = projectBadge(item.project);
  const title = rowTitle(item);
  const message = item.lastText !== null ? plainPreview(item.lastText) : "";
  const detail = message || reasonLabel(a.reason);
  const parts = statusParts(item, now, !preview);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="group relative flex min-w-0 flex-wrap items-start rounded-lg transition-colors hover:bg-accent/60 has-[a:focus-visible]:bg-accent/60">
      <Link
        to={inboxHref(item)}
        title={!preview && message ? message : undefined}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg py-2 pl-3 pr-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [@media(hover:hover)]:pr-11"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("grid h-4 min-w-5 flex-none place-items-center rounded px-0.5 text-[9px] font-bold leading-none tracking-wide", BADGE[badge.slot])} aria-hidden="true">
            {badge.letters}
          </span>
          <span className="min-w-0 truncate">{item.project}<span className="opacity-60"> / </span>{item.repo}</span>
          <Dot />
          {parts && <><Status item={item} now={now} parts={parts} /><Dot /></>}
          <span className="flex-none">{profileFor(item.agent).short}</span>
          {item.runtime === "tmux" && <span className="flex-none opacity-80"><span className="sr-only">in </span>tmux</span>}
        </span>
        {/* Groups below Needs you get a quieter title so they read as background. */}
        <span className={cn("truncate text-sm", preview ? "font-medium text-foreground" : "text-foreground/85")}>{title}</span>
        {preview && <span className="truncate text-xs text-muted-foreground/75">{detail}</span>}
      </Link>
      <RowMenu item={item} label={title} onItem={onItem} setError={setError} />
      {error && <p role="alert" className="basis-full px-3 pb-2 text-xs text-destructive">{error}</p>}
    </li>
  );
}

function Rows({ items, now, onItem, preview }: { items: InboxItem[]; now: number; onItem: (i: InboxItem) => void; preview: boolean }) {
  return <ul className="flex flex-col gap-0.5">{items.map((i) => <Row key={i.sessionId} item={i} now={now} onItem={onItem} preview={preview} />)}</ul>;
}

/** A quiet group heading: name, count, and for the shelves a chevron that opens them. */
function GroupHead({ label, count, open, onToggle, id }: { label: string; count: number; open?: boolean; onToggle?: () => void; id: string }) {
  const body = (
    <>
      <span className="font-medium text-foreground/90">{label}</span>
      <span className="tabular-nums text-muted-foreground">{count}</span>
      {onToggle && <span className="ml-auto"><Chevron open={!!open} /></span>}
    </>
  );
  return onToggle ? (
    <h2 className="mb-1">
      <button
        type="button" id={id} aria-expanded={open} onClick={onToggle}
        className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/60"
      >{body}</button>
    </h2>
  ) : (
    <h2 id={id} className="mb-1 flex min-h-9 items-center gap-2 px-3 text-sm">{body}</h2>
  );
}

/** An open group; empty ones are not shown. With `cap`, rows past it hide behind a counted "N more" toggle. */
function Group({ label, items, now, onItem, preview, cap }: {
  label: string; items: InboxItem[]; now: number; onItem: (i: InboxItem) => void; preview: boolean; cap?: number;
}) {
  const [all, setAll] = useState(false);
  const id = `inbox-${label.toLowerCase().replace(/\s+/g, "-")}`;
  if (items.length === 0) return null;
  const hidden = cap !== undefined && !all ? Math.max(0, items.length - cap) : 0;
  return (
    <section aria-labelledby={id} className="mb-5">
      <GroupHead id={id} label={label} count={items.length} />
      <Rows items={hidden ? items.slice(0, cap) : items} now={now} onItem={onItem} preview={preview} />
      {cap !== undefined && items.length > cap && (
        <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)}
          className="mt-0.5 flex min-h-9 items-center gap-1 rounded-md px-3 text-sm text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
          {all ? "Show fewer" : `${hidden} more`}<Chevron open={all} />
        </button>
      )}
    </section>
  );
}

/** A group that starts collapsed (Working, Snoozed, Settled); not shown while empty. */
function Shelf({ label, items, now, onItem, preview }: { label: string; items: InboxItem[]; now: number; onItem: (i: InboxItem) => void; preview: boolean }) {
  const [open, setOpen] = useState(false);
  const id = `inbox-${label.toLowerCase().replace(/\s+/g, "-")}`;
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id} className="mb-1">
      <GroupHead id={id} label={label} count={items.length} open={open} onToggle={() => setOpen((o) => !o)} />
      <Collapse open={open}><div className="pb-3"><Rows items={items} now={now} onItem={onItem} preview={preview} /></div></Collapse>
    </section>
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
  const split = g ? splitNeedsYou(g.needsYou) : null;
  // A row action answers the session's new item: shown at once, the SSE event that follows is the same.
  const onItem = (item: InboxItem) => setItems((cur) => (cur === null ? cur : upsertInbox(cur, item)));

  return (
    <AppPage title="Inbox" sub="What needs you first, then what finished, then the rest.">
      {(paused || badFrame) && (
        <p role="status" className="mb-4 rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {paused ? `live updates paused — refreshing every 5 s${pollError ? ` (last refresh failed: ${pollError})` : ""}` : `live update dropped: ${badFrame}`}
        </p>
      )}
      {!g ? (pollError ? <p role="alert" className="text-sm text-destructive">{pollError}</p> : <RowsSkeleton rows={4} />) : (
        <>
          <div className="-mx-3 max-w-[720px]">
            {split!.action.length === 0 && (
              <p className="mb-5 flex min-h-9 items-center gap-2 px-3 text-sm text-muted-foreground">
                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />Nothing waiting for you
              </p>
            )}
            <Group label="Needs you" items={split!.action} now={now} onItem={onItem} preview />
            <Group label="Finished" items={split!.finished} now={now} onItem={onItem} preview={false} cap={5} />
            <Group label="Idle" items={g.idle} now={now} onItem={onItem} preview={false} />
            {g.working.length + g.snoozed.length + g.settled.length > 0 && (
              <div className="border-t pt-2">
                <Shelf label="Working" items={g.working} now={now} onItem={onItem} preview />
                <Shelf label="Snoozed" items={g.snoozed} now={now} onItem={onItem} preview />
                <Shelf label="Settled" items={g.settled} now={now} onItem={onItem} preview={false} />
              </div>
            )}
          </div>
        </>
      )}
    </AppPage>
  );
}
