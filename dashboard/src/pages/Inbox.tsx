import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlarmClock, Check, CircleAlert, CircleCheck, Ellipsis, MessageCircleQuestion, Undo2 } from "lucide-react";
import type { InboxItem } from "../../../shared/thread";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "../api";
import { AgentLogo, logoForAgent } from "../components/agentLogos";
import { AppPage, Chevron, Collapse, RowsSkeleton } from "../components/primitives";
import { SettleProblem } from "../components/SettleProblem";
import { agoLabel } from "../format";
import { claimsUndo, failureText, focusOwnsUndo, settleKey, settleShortcut } from "../inboxSettle";
import { groupInbox, inboxHref, inboxList, mixedAgents, reasonLabel, rowMark, rowTitle, secondLine, shelfBlock, shortAgo, snoozeTimes, upsertInbox, type MarkTone } from "../inboxView";
import { cn } from "@/lib/utils";
import { profileFor } from "../newSession";
import { useNow } from "../store";
import { useEventStream } from "../useEventStream";
import { settler, useSettleState } from "../useSettler";

const untilLabel = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const shortUntil = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl+";
const SETTLE_CHORD = MAC ? "⌘⇧S" : "Ctrl+Shift+S";

/** Whether rows show their agent's mark (mixedAgents over the whole inbox). True by default on purpose: a row outside
 *  the provider shows its agent rather than hide which one runs. */
const ShowAgent = createContext(true);
/** Settles a row from the list: its ✓, E, ⌘⇧S and the menu all go through the page, which moves the focus on. */
const SettleRow = createContext<((item: InboxItem) => void) | null>(null);

function useSettleRow(): (item: InboxItem) => void {
  const settle = useContext(SettleRow);
  if (!settle) throw new Error("an inbox row is rendered outside the Inbox page's SettleRow provider");
  return settle;
}

/** Settle, unsettle and snooze. "Until the limit resets" asks devd when the menu opens; it stays disabled with
 *  devd's reason when there is no active limit (or no meter for this agent). */
function RowMenu({ item, label, onItem, setError, className }: {
  item: InboxItem; label: string; onItem: (i: InboxItem) => void; setError: (e: string | null) => void; className: string;
}) {
  const settle = useSettleRow();
  const [reset, setReset] = useState<{ resetsAt: number } | { reason: string } | null>(null);
  const section = item.attention.section;
  const run = (p: Promise<InboxItem>) => {
    setError(null);
    p.then(onItem, (e: unknown) => setError(failureText(e)));
  };
  const blocked = shelfBlock(item);
  const open = (o: boolean) => {
    if (!o || section === "settled" || section === "snoozed" || blocked !== null) return;
    setReset(null);
    api.snoozeReset(item.sessionId).then(setReset, (e: unknown) => setReset({ reason: failureText(e) }));
  };
  const t = snoozeTimes(new Date());
  return (
    <DropdownMenu onOpenChange={open}>
      <DropdownMenuTrigger aria-label={`Actions for ${label}`} title="More actions" className={className}>
        <Ellipsis className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={16} className="w-64 max-w-[calc(100vw-2rem)]">
        {section === "settled" || section === "snoozed" ? (
          <DropdownMenuItem onSelect={() => run(api.unsettle(item.sessionId))}>Back to the inbox</DropdownMenuItem>
        ) : (
          <>
            {blocked && <p className="px-2 py-1.5 text-xs text-muted-foreground">{blocked}</p>}
            <DropdownMenuItem disabled={blocked !== null} onSelect={() => settle(item)}>
              Settle<span className="ml-auto text-xs tracking-wide text-muted-foreground">E</span>
            </DropdownMenuItem>
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
  );
}

const MARK_TONE: Record<MarkTone, string> = {
  action: "font-semibold text-amber-700 dark:text-amber-300",
  danger: "font-semibold text-red-600 dark:text-red-400",
  // A finished run is news, not a block: a green check and a regular muted word, under the asks.
  done: "text-muted-foreground [&>svg]:text-emerald-600 dark:[&>svg]:text-emerald-400",
};

const MARK_ICON: Record<MarkTone, typeof CircleAlert> = { action: MessageCircleQuestion, danger: CircleAlert, done: CircleCheck };

/** The title line's right end: the mark when the row has something to say, else how long ago (after a live dot while
 *  it works), or when a snooze ends. Under the pointer or the keyboard it gives way to the ✓ (hover devices). */
function State({ item, now }: { item: InboxItem; now: number }) {
  const a = item.attention;
  const mark = rowMark(item);
  if (mark) {
    const Icon = MARK_ICON[mark.tone];
    return (
      <span className={cn("flex flex-none items-center gap-1 text-xs", MARK_TONE[mark.tone])}>
        <Icon className="size-3.5 flex-none" aria-hidden="true" />{mark.label}
      </span>
    );
  }
  if (a.until) {
    return <span className="flex flex-none items-center gap-1 text-xs tabular-nums text-muted-foreground"><AlarmClock className="size-3.5" aria-hidden="true" />{shortUntil(a.until)}</span>;
  }
  return (
    <span className="flex flex-none items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
      {a.section === "working" && <span className="size-1.5 animate-pulse rounded-full bg-sky-500 motion-reduce:animate-none" aria-hidden="true" />}
      {a.since > 0 ? shortAgo(now - a.since) : ""}
    </span>
  );
}

/** What the row says to a screen reader and in its tooltip: the mark first and not again as the state. */
function spoken(item: InboxItem, now: number, title: string, showAgent: boolean): string {
  const a = item.attention;
  const mark = rowMark(item);
  const when = a.until ? `until ${untilLabel(a.until)}` : a.since > 0 ? agoLabel(now - a.since) : "";
  const state = mark ? mark.label : a.section === "idle" || a.section === "settled" ? "" : reasonLabel(a.reason) || a.section;
  return [mark?.label, title, mark ? "" : state, when, secondLine(item), showAgent ? profileFor(item.agent).short : "", item.runtime === "tmux" ? "tmux" : ""]
    .filter(Boolean).join(", ");
}

// The actions sit over the row's right end: the ✓ in the state's place on the title line, the menu in the agent
// mark's place on the second. On a touch screen (no hover) only the menu shows, always, beside the row.
const ACTION = "grid place-items-center rounded-md text-muted-foreground outline-none transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60";
const ON_HOVER = "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100";
const HIDE_ON_HOVER = "[@media(hover:hover)]:group-hover:invisible [@media(hover:hover)]:group-has-[:focus-visible]:invisible [@media(hover:hover)]:group-has-[[data-state=open]]:invisible";

/** A row: the title with its state on the right, and one muted line (secondLine) ending in the agent's mark while the
 *  inbox mixes agents (MacInboxRow). A row of the list with nothing to say has a title a step lighter, so the eye lands
 *  on the marked ones first. `settle`: the row offers the ✓ (not on the snoozed and settled shelves). */
function Row({ item, now, onItem, quiet, settle }: { item: InboxItem; now: number; onItem: (i: InboxItem) => void; quiet: boolean; settle: boolean }) {
  const showAgent = useContext(ShowAgent);
  const onSettle = useSettleRow();
  const blockId = useId();
  const title = rowTitle(item);
  const block = shelfBlock(item);
  const label = spoken(item, now, title, showAgent);
  const [error, setError] = useState<string | null>(null);
  return (
    <li data-inbox-row={item.sessionId} className="group relative flex min-w-0 flex-wrap rounded-lg transition-colors [@media(hover:hover)]:hover:bg-accent/60 has-[:focus-visible]:bg-accent/60 has-[[data-state=open]]:bg-accent/60">
      <Link
        to={inboxHref(item)} aria-label={label} title={settle && block === null ? `${label}\nE to settle` : label}
        aria-keyshortcuts={settle && block === null ? "E" : undefined}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg py-2 pl-3 pr-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [@media(hover:none)]:pr-1"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", quiet ? "text-foreground/70" : "text-foreground")}>{title}</span>
          <span className={cn("flex min-w-6 flex-none justify-end", settle && HIDE_ON_HOVER)}><State item={item} now={now} /></span>
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{secondLine(item)}</span>
          {item.runtime === "tmux" && <span className="flex-none text-[11px] opacity-80">tmux</span>}
          {showAgent && <AgentLogo name={logoForAgent(item.agent)} size={12} className="w-6 opacity-70 [@media(hover:hover)]:group-hover:invisible [@media(hover:hover)]:group-has-[:focus-visible]:invisible [@media(hover:hover)]:group-has-[[data-state=open]]:invisible" />}
          {!showAgent && <span className="hidden w-6 flex-none [@media(hover:hover)]:block" aria-hidden="true" />}
        </span>
      </Link>
      {settle && (
        <button
          type="button" aria-label={`Settle ${title} (E)`} aria-disabled={block !== null || undefined}
          aria-describedby={block !== null ? blockId : undefined} aria-keyshortcuts={block === null ? "E" : undefined}
          title={block ?? `Settle (E or ${SETTLE_CHORD})`}
          onClick={() => { if (block === null) onSettle(item); }}
          className={cn(ACTION, ON_HOVER, "absolute right-2.5 top-[7px] hidden h-[22px] w-6 [@media(hover:hover)]:grid",
            block !== null && "cursor-not-allowed text-muted-foreground/45 hover:bg-transparent hover:text-muted-foreground/45")}
        >
          <Check className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
          {block !== null && <span id={blockId} className="sr-only">{block}</span>}
        </button>
      )}
      <RowMenu item={item} label={title} onItem={onItem} setError={setError}
        className={cn(ACTION, ON_HOVER, "size-9 flex-none self-center [@media(hover:hover)]:absolute [@media(hover:hover)]:bottom-[7px] [@media(hover:hover)]:right-2.5 [@media(hover:hover)]:size-auto [@media(hover:hover)]:h-[18px] [@media(hover:hover)]:w-6")} />
      {error && <p role="alert" className="basis-full px-3 pb-2 text-xs text-destructive">{error}</p>}
    </li>
  );
}

function Rows({ items, now, onItem, quiet, settle }: { items: InboxItem[]; now: number; onItem: (i: InboxItem) => void; quiet?: boolean; settle: boolean }) {
  return (
    <ul className="flex flex-col gap-px">
      {items.map((i) => <Row key={i.sessionId} item={i} now={now} onItem={onItem} quiet={!!quiet && rowMark(i) === null} settle={settle} />)}
    </ul>
  );
}

/** A collapsed shelf under the list (Working, Snoozed, Settled); not shown while empty. */
function Shelf({ label, items, now, onItem, settle }: { label: string; items: InboxItem[]; now: number; onItem: (i: InboxItem) => void; settle: boolean }) {
  const [open, setOpen] = useState(false);
  const id = `inbox-${label.toLowerCase()}`;
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <h2>
        <button
          type="button" id={id} aria-expanded={open} onClick={() => setOpen((o) => !o)}
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Chevron open={open} />
          <span className="font-medium">{label}</span>
          <span className="ml-auto tabular-nums">{items.length}</span>
        </button>
      </h2>
      <Collapse open={open}><div className="pb-2"><Rows items={items} now={now} onItem={onItem} settle={settle} /></div></Collapse>
    </section>
  );
}

/** After a settle: "Settled <title> · ⌘Z to undo" for a few seconds, longer while the pointer or the keyboard is on it.
 *  The live region is always mounted so a screen reader hears each settle once. */
function SettleNotice({ onUndo }: { onUndo: () => void }) {
  const { notice } = useSettleState();
  // Leaving the page while holding the notice lets it go, or it would wait for a pointer that never leaves.
  useEffect(() => () => settler.hold(false), []);
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      onPointerEnter={() => settler.hold(true)} onPointerLeave={() => settler.hold(false)}
      onFocus={() => settler.hold(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) settler.hold(false); }}>
      {notice && (
        <div className="flex min-h-11 items-center gap-2 rounded-lg border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-lg">
          <Check className="size-3.5 flex-none text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} aria-hidden="true" />
          <span className="flex-none">Settled</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{notice.title}</span>
          <span className="sr-only">. {MOD}Z to undo.</span>
          <button type="button" onClick={onUndo} title={`Undo the settle (${MOD}Z)`}
            className="flex h-7 flex-none items-center gap-1.5 rounded-md bg-foreground/[0.07] px-2 text-xs text-foreground/85 outline-none hover:bg-foreground/[0.12] focus-visible:ring-2 focus-visible:ring-ring/60">
            <Undo2 className="size-3.5" aria-hidden="true" /><span aria-hidden="true">{MOD}Z to undo</span><span className="sr-only">Undo</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The inbox as one list: what asks for the owner pinned on top, the longest wait first, then everything else that is
 *  not working, snoozed or settled, newest first (inboxList), and those three as collapsed shelves under it. A row
 *  settles in one gesture (its ✓, E, ⌘⇧S), undone with ⌘Z while the notice shows. Live over the SSE stream; polled
 *  every 5 s while the stream is down. */
export function Inbox() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const now = useNow(15_000);
  const { notice } = useSettleState();
  const { paused, pollError, badFrame } = useEventStream({
    enabled: true,
    onInboxList: setItems,
    // Until the first full list arrives a single item would read as the whole inbox.
    onInbox: (item) => setItems((cur) => (cur === null ? cur : upsertInbox(cur, item))),
  });
  const g = items ? groupInbox(items) : null;
  const list = g ? inboxList(g) : [];
  // A row action answers the session's new item: shown at once, the SSE event that follows is the same.
  const onItem = (item: InboxItem) => setItems((cur) => (cur === null ? cur : upsertInbox(cur, item)));
  const listRef = useRef<HTMLDivElement | null>(null);

  const rowLink = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-inbox-row="${CSS.escape(id)}"] a`);
  /** Once devd answered, the keyboard goes to row `id`, but only if it is still where the gesture left it, in the row
   *  the gesture was on (a closed menu hands focus back to its trigger there), or lost with that row: someone who
   *  moved on during a slow request keeps their focus. */
  const focusAfter = (id: string | undefined, before: Element | null, row?: Element | null) => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (id && (active === before || active === null || active === document.body || (!!row && row.contains(active)))) rowLink(id)?.focus();
  });
  // A settled row leaves: the keyboard moves on to the row that takes its place (or the one above the last).
  const settle = (item: InboxItem) => {
    const before = document.activeElement;
    const li = rowLink(item.sessionId)?.closest("li");
    const nextId = ((li?.nextElementSibling ?? li?.previousElementSibling) as HTMLElement | null)?.dataset.inboxRow;
    void settler.settle(item).then((next) => {
      if (!next) return;
      onItem(next);
      focusAfter(nextId, before, li);
    });
  };
  // An undone row comes back with the keyboard on it.
  const undo = () => {
    const before = document.activeElement;
    void settler.undo().then((back) => {
      if (!back) return;
      onItem(back);
      focusAfter(back.sessionId, before);
    });
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const noticeShown = notice !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const focused = document.activeElement as HTMLElement | null;
      if (settleShortcut(e, MAC) || (!e.defaultPrevented && settleKey(e, focusOwnsUndo(focused as HTMLInputElement | null)))) {
        const id = (document.activeElement?.closest("[data-inbox-row]") as HTMLElement | null)?.dataset.inboxRow;
        const item = id ? itemsRef.current?.find((i) => i.sessionId === id) : undefined;
        if (!item || item.attention.section === "settled" || item.attention.section === "snoozed") return;
        e.preventDefault();
        settleRef.current(item);
      } else if (claimsUndo(e, MAC, { noticeShown, focusOwnsUndo: focusOwnsUndo(document.activeElement as HTMLInputElement | null) })) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [noticeShown]);

  return (
    <AppPage title="Inbox" sub="What asks for you on top, then the rest, newest first.">
      {(paused || badFrame) && (
        <p role="status" className="mb-4 rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {paused ? `live updates paused — refreshing every 5 s${pollError ? ` (last refresh failed: ${pollError})` : ""}` : `live update dropped: ${badFrame}`}
        </p>
      )}
      {!g ? (pollError ? <p role="alert" className="text-sm text-destructive">{pollError}</p> : <RowsSkeleton rows={4} />) : (
        <ShowAgent.Provider value={mixedAgents(items!)}>
        <SettleRow.Provider value={settle}>
          <div ref={listRef} className="-mx-3 max-w-[720px]" data-inbox-column>
            {list.length === 0 ? (
              <p className="mb-3 flex min-h-9 items-center gap-2 px-3 text-sm text-muted-foreground">
                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />Nothing waiting for you
              </p>
            ) : (
              <section aria-label="Inbox" className="mb-3"><Rows items={list} now={now} onItem={onItem} quiet settle /></section>
            )}
            {g.working.length + g.snoozed.length + g.settled.length > 0 && (
              <div className="border-t pt-1.5">
                <Shelf label="Working" items={g.working} now={now} onItem={onItem} settle />
                <Shelf label="Snoozed" items={g.snoozed} now={now} onItem={onItem} settle={false} />
                <Shelf label="Settled" items={g.settled} now={now} onItem={onItem} settle={false} />
              </div>
            )}
            <div className="sticky bottom-20 z-10 mt-3 flex flex-col gap-2 px-3 lg:bottom-4">
              <SettleProblem />
              <SettleNotice onUndo={undo} />
            </div>
          </div>
        </SettleRow.Provider>
        </ShowAgent.Provider>
      )}
    </AppPage>
  );
}
