import { useEffect, useMemo, useState } from "react";
import { api, type ActivityEvent } from "../api";
import {
  ActionButton, AppPage, EmptyState, Pager, RowsSkeleton, Section, StatusDot,
} from "../components/primitives";
import { DateRangePicker } from "../components/DateRangePicker";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { presetRange } from "@/lib/range";
import { agoLabel } from "../format";
import { useNow, useStore } from "../store";
import { eventDetail, eventLabel, sessionShort, type EventKind } from "../eventLabels";
import { LOG_GROUPS, pageCount, toggle, typesForGroups, ungroupedTypes } from "../logView";

const PER_PAGE = 50;
const DOT_KIND: Record<EventKind, string> = { ok: "ok", warn: "waiting", danger: "danger", info: "idle" };
const BADGE_TONE: Record<EventKind, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
  info: "text-muted-foreground",
};

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn(
        "h-8 rounded-full border px-3 text-xs font-medium transition-colors",
        active ? "border-foreground bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Log() {
  const { live } = useStore();
  const now = useNow(10_000);

  // The default window is 30 days — an unbounded "whole log" would on the first load
  // reach across the whole history and the user would only see the first 50 anyway.
  const [range, setRange] = useState(() => presetRange("30d", Date.now()));
  const [groups, setGroups] = useState<string[]>([]);
  const [session, setSession] = useState("");
  const [p, setP] = useState(0);

  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [allTypes, setAllTypes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const types = useMemo(() => typesForGroups(groups, allTypes), [groups, allTypes]);

  async function load(pageIndex = p) {
    setErr(null);
    const r = await api.eventsPaged({
      limit: PER_PAGE,
      offset: pageIndex * PER_PAGE,
      from: range.from,
      to: range.to,
      session: session || undefined,
      types: types.length ? types : undefined,
    });
    setEvents(r.items);
    setTotal(r.total);
    setAllTypes(r.types);
  }

  // Changing the filter always jumps to the first page — otherwise after narrowing the
  // selection the user would be looking at an empty fifth page.
  useEffect(() => { setP(0); }, [range.from, range.to, session, groups]);

  useEffect(() => {
    let alive = true;
    setEvents(null);
    api.eventsPaged({
      limit: PER_PAGE,
      offset: p * PER_PAGE,
      from: range.from,
      to: range.to,
      session: session || undefined,
      types: types.length ? types : undefined,
    })
      .then((r) => { if (alive) { setEvents(r.items); setTotal(r.total); setAllTypes(r.types); } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setEvents([]); } });
    return () => { alive = false; };
  }, [p, range.from, range.to, session, types.join(",")]);

  const pages = pageCount(total, PER_PAGE);
  const hasOther = ungroupedTypes(allTypes).length > 0;
  const sessions = live?.sessions ?? [];
  const filtersOn = groups.length > 0 || session !== "";

  return (
    <AppPage
      title="Log"
      sub="Everything that happened — sessions, agents, upkeep, production writes."
      actions={<DateRangePicker value={range} onChange={setRange} />}
    >
      <Section
        label="Filters"
        meta={filtersOn && (
          <Button variant="ghost" size="sm" onClick={() => { setGroups([]); setSession(""); }}>Clear filters</Button>
        )}
      >
        <Card><CardContent className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap gap-1.5">
            {LOG_GROUPS.map((g) => (
              <Chip key={g.id} active={groups.includes(g.id)} onClick={() => setGroups((s) => toggle(s, g.id))}>
                {g.label}
              </Chip>
            ))}
            {hasOther && (
              <Chip active={groups.includes("other")} onClick={() => setGroups((s) => toggle(s, "other"))}>Other</Chip>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-8 max-w-full rounded-md border bg-background px-2 text-sm"
              value={session}
              onChange={(e) => setSession(e.target.value)}
              aria-label="Filter by session"
            >
              <option value="">all sessions</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.name?.trim() || `${s.project}/${s.repo}`}</option>)}
            </select>
            <ActionButton variant="outline" size="sm" onAction={() => load()} onError={setErr}>Refresh</ActionButton>
            <span className="text-xs text-muted-foreground">
              {events === null ? "loading…" : `${total} ${total === 1 ? "event" : "events"}`}
            </span>
          </div>
          {err && <span className="text-xs font-medium text-destructive">Error: {err}</span>}
        </CardContent></Card>
      </Section>

      <Section label="Events">
        {events === null ? <RowsSkeleton rows={8} height={64} /> : events.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            hint={filtersOn ? "Try widening the filters or the date range." : "Once something runs, it shows up here."}
          />
        ) : (
          <>
            <Card><CardContent className="flex flex-col divide-y p-0">
              {events.map((e) => {
                const { label, kind } = eventLabel(e.type);
                const detail = eventDetail(e.data);
                return (
                  <div key={e.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="pt-1"><StatusDot kind={DOT_KIND[kind]} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={cn("font-medium", BADGE_TONE[kind])}>{label}</Badge>
                        <span className="text-xs text-muted-foreground">{sessionShort(e.session_id)}</span>
                      </div>
                      {detail && <div className="mt-1 break-words text-xs text-muted-foreground">{detail}</div>}
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground" title={new Date(e.ts).toLocaleString("en-US")}>
                      {agoLabel(now - e.ts)}
                    </div>
                  </div>
                );
              })}
            </CardContent></Card>
            <Pager page={p} pages={pages} onPage={setP} />
          </>
        )}
      </Section>
    </AppPage>
  );
}
