import { DollarSign, Sparkles, Clock3, ArrowUpRight, ArrowDownRight, Folder, GitBranch, SlidersHorizontal, X, RefreshCw, ListFilter } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { api, type RangeStats, type WorkHours } from "../api";
import {
  AppPage, CardsSkeleton, EmptyState, Pager, ScrollX, Section,
} from "../components/primitives";
import { DateRangePicker } from "../components/DateRangePicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { presetRange, rangeDays } from "@/lib/range";
import { compactNumber, czCurrency, czInt } from "../format";
import { hourLabel, msLabel, page, peakHour, projectOptions, quantileLabel, share, toRanked, totalCost, type Ranked } from "../statsView";
import { hostLabel, hostOptions, previousFor, seriesFor, totalsFor, unknownLabel, type HostFilter } from "../statsHostView";
import { cappedNote, formatHours } from "../workHoursView";

type Metric = "cost" | "tokens" | "hours";
const METRICS: { id: Metric; label: string; fmt: (n: number) => string }[] = [
  { id: "cost", label: "Cost", fmt: czCurrency },
  { id: "tokens", label: "Tokens", fmt: compactNumber },
  { id: "hours", label: "Active time", fmt: (n) => `${n.toFixed(1)} h` },
];
const COLORS = ["#6366f1", "#06b6d4", "#a855f7", "#f59e0b", "#10b981"];
const chartConfig: ChartConfig = { value: { label: "Value", color: "var(--chart-1)" } };
const delta = (cur: number, prev: number) => (prev <= 0 ? null : ((cur - prev) / prev) * 100);
const dayLabel = (t: number) => new Date(t).toLocaleDateString("en-US", { day: "numeric", month: "numeric" });
// Radix Select does not accept an empty value as an item, so "no filter" needs a
// sentinel (same as "none"/"off" in Settings). Underscores on purpose: a plain "all"
// would collide with a project that happened to have that name.
const ALL = "__all__";

function MetricCard({ kind, value, change }: { kind: Metric; value: string; change: number | null }) {
  const style = {
    cost: { label: "Cost", icon: DollarSign, tone: "border-emerald-500/20 bg-emerald-500/5", ink: "text-emerald-700 dark:text-emerald-400", tint: "bg-emerald-500/10" },
    tokens: { label: "Tokens", icon: Sparkles, tone: "border-blue-500/20 bg-blue-500/5", ink: "text-blue-700 dark:text-blue-400", tint: "bg-blue-500/10" },
    hours: { label: "Active time", icon: Clock3, tone: "border-violet-500/20 bg-violet-500/5", ink: "text-violet-700 dark:text-violet-400", tint: "bg-violet-500/10" },
  }[kind];
  const Icon = style.icon;
  const Arrow = (change ?? 0) >= 0 ? ArrowUpRight : ArrowDownRight;
  return <Card className={cn("shadow-none", style.tone)}><CardContent className="p-5">
    <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-muted-foreground">{style.label}</span><span className={cn("flex size-9 items-center justify-center rounded-lg", style.ink, style.tint)}><Icon className="size-4" aria-hidden="true" /></span></div>
    <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2"><span className={cn("text-3xl font-semibold tracking-tight tabular-nums", style.ink)}>{value}</span>{change !== null && <span title="Change versus previous period" aria-label={`${Math.abs(change).toFixed(0)} percent ${change >= 0 ? "increase" : "decrease"} versus previous period`} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium tabular-nums", style.ink, style.tint)}><Arrow className="size-3" aria-hidden="true" />{Math.abs(change).toFixed(0)}%</span>}</div>
  </CardContent></Card>;
}

/* --------------------------- leaderboard with click-through --------------------------- */

function Leaderboard(
  { title, rows, unit, onPick, active }:
  {
    title: string; rows: Ranked[]; unit: string;
    /** When set, rows can be clicked to act as a filter (clicking the active one clears it). */
    onPick?: (key: string | null) => void;
    active?: string | null;
  },
) {
  const [expanded, setExpanded] = useState(false);
  const [p, setP] = useState(0);
  const total = totalCost(rows);
  const view = expanded ? page(rows, p, 25) : { items: rows.slice(0, 5), page: 0, pages: 1 };

  return (
    <Section
      label={title}
      meta={rows.length > 5 && (
        <Button variant="ghost" size="sm" onClick={() => { setExpanded((v) => !v); setP(0); }}>
          <ListFilter className="size-4" aria-hidden="true" />{expanded ? "Show top 5" : `Show all ${rows.length}`}
        </Button>
      )}
    >
      <Card><CardContent className="p-4">
        {rows.length === 0 ? <EmptyState title={`No ${unit} activity in this period`} /> : (
          <>
            <div className="space-y-2.5">
              {view.items.map((r, i) => {
                // No click-through for the "—" row (bucket without the attribute) — it cannot be filtered on.
                const pickable = !!onPick && r.key !== "—";
                const cells = (
                  <>
                    <span className="font-mono text-xs text-muted-foreground">
                      {String(view.page * 25 + i + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0">
                      {/* "—" is the SQL fallback for a missing attribute (e.g. a Mac session without a project) —
                          we show a readable Unknown, not a bare dash. */}
                      <div className="truncate text-left text-sm font-medium" title={unknownLabel(r.key)}>{unknownLabel(r.key)}</div>
                      <div className="mt-1 h-1.5 rounded-full bg-muted">
                        <div className="h-full rounded-full" style={{ width: `${share(r.cost, total)}%`, backgroundColor: COLORS[(view.page * 25 + i) % COLORS.length] }} />
                      </div>
                    </div>
                    <div className="text-right font-mono text-sm tabular-nums">
                      {czCurrency(r.cost)}
                      <div className="text-xs text-muted-foreground" title={`${czInt(r.tokens)} tokens`}>
                        {compactNumber(r.tokens)} tok · {Math.round(share(r.cost, total))}%
                      </div>
                    </div>
                  </>
                );
                const grid = "grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3";
                return pickable ? (
                  <button
                    key={r.key} type="button"
                    onClick={() => onPick!(active === r.key ? null : r.key)}
                    title={active === r.key ? "Clear the filter" : `Show only ${r.key}`}
                    className={cn(grid, "w-full rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60",
                      active === r.key && "bg-muted ring-1 ring-[var(--chart-1)]")}
                  >
                    {cells}
                  </button>
                ) : (
                  <div key={r.key} className={cn(grid, onPick && "px-1.5 py-1")}>{cells}</div>
                );
              })}
            </div>
            {expanded && <Pager page={view.page} pages={view.pages} onPage={setP} />}
          </>
        )}
      </CardContent></Card>
    </Section>
  );
}

/* ---------------------------------- page ---------------------------------- */

export function Stats() {
  // The default is TODAY (used to be 30 days) — the user wants to see today's state on open.
  const [range, setRange] = useState(() => presetRange("today", Date.now()));
  const [data, setData] = useState<RangeStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("cost");
  const [hourlyMetric, setHourlyMetric] = useState<"hours" | "cost">("hours");
  const [reload, setReload] = useState(0);
  const [host, setHost] = useState<HostFilter>("all");
  // Separate state for Work hours: different endpoint, different timing than statsRange —
  // a failure of one must not hide the data of the other.
  const [work, setWork] = useState<WorkHours | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  // The project filter lives in the URL (?project=…), not in state — a link to "how much
  // does this project cost" can be shared and survives a reload. Modeled on ?open= in Sessions.
  const [params, setParams] = useSearchParams();
  const project = params.get("project") || null;
  const repo = params.get("repo") || null;
  function pickRepo(next: string | null) {
    const p = new URLSearchParams(params);
    if (next) p.set("repo", next); else p.delete("repo");
    setParams(p, { replace: true });
  }
  function clearFilters() {
    const p = new URLSearchParams(params); p.delete("project"); p.delete("repo");
    setParams(p, { replace: true });
  }
  function pickProject(next: string | null) {
    const p = new URLSearchParams(params);
    if (next) p.set("project", next); else p.delete("project");
    p.delete("repo");
    setParams(p, { replace: true });
  }
  // The project options are kept in their own state: `data` is reset on every load
  // (skeleton) and the selector would flicker to empty between ranges.
  const [options, setOptions] = useState<string[]>([]);
  const [repoOptions, setRepoOptions] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    let pending = false;
    setData(null); setError(null);
    const load = async () => {
      if (pending || !alive) return;
      pending = true;
      try {
        const d = await api.statsRange(range.from, range.to, project, repo);
        if (alive) { setData(d); setError(null); setOptions(projectOptions(d.projects, project)); setRepoOptions([...new Set([...(d.repoOptions ?? d.repos.map(r => r.repo)), ...(repo ? [repo] : [])])].sort()); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "failed to load"); }
      finally { pending = false; }
    };
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    void load();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false; window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [range.from, range.to, project, repo, reload]);

  useEffect(() => {
    let alive = true;
    let pending = false;
    setWork(null); setWorkError(null);
    const load = async () => {
      if (pending || !alive) return;
      pending = true;
      try {
        const w = await api.workHours(range.from, range.to, project, repo);
        if (alive) { setWork(w); setWorkError(null); }
      } catch (e) { if (alive) setWorkError(e instanceof Error ? e.message : "failed to load"); }
      finally { pending = false; }
    };
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    void load();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false; window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [range.from, range.to, project, repo, reload]);

  const m = METRICS.find((x) => x.id === metric)!;
  const hasData = !!data && (data.totals.cost > 0 || data.totals.tokens > 0 || data.totals.hours > 0);
  const days = rangeDays(range);

  const projects = useMemo(() => toRanked(data?.projects ?? [], "project"), [data]);
  const models = useMemo(() => toRanked(data?.models ?? [], "model"), [data]);
  const repos = useMemo(() => toRanked(data?.repos ?? [], "repo"), [data]);
  const peak = data ? peakHour(data.hourly) : null;
  const accounts = data?.accounts ?? [];
  // Both endpoints apply the same project and repository scope.
  const shownWork = work;

  // Hosts for the Mac/Devbox/All selector — sorted alphabetically (hostOptions), so the order
  // does not depend on cost and does not shuffle between ranges.
  const hosts = data ? hostOptions(data) : [];
  // The selector can "lose" its host: pick Mac and switch the range to a period
  // before the mac page was deployed → hosts shrinks to one and the selector disappears,
  // but the `host` state still holds "mac". Without clamping the page would silently show
  // "No data" with no way back. effHost falls back to "all" unless
  // the selected host actually exists in the data.
  const effHost: HostFilter = host === "all" || hosts.includes(host) ? host : "all";
  const shownTotals = data ? totalsFor(data, effHost) : null;
  const shownPrevious = data ? previousFor(data, effHost) : null;
  const chartHasData = !!shownTotals && (shownTotals.cost > 0 || shownTotals.tokens > 0 || shownTotals.hours > 0);

  // recharts wants a single array of objects; per-host series become columns day → { host: value }.
  const seriesHosts = effHost === "all" ? (data?.dailyByHost ?? []).map((h) => h.host) : [effHost];
  const series = data ? seriesFor(data, effHost) : [];
  const chartRows = (series[0] ?? []).map((_, i) => {
    const row: Record<string, string | number> = { day: dayLabel(series[0][i].day) };
    seriesHosts.forEach((h, si) => { row[h] = series[si]?.[i]?.[metric] ?? 0; });
    return row;
  });

  return (
    <AppPage
      title="Statistics"
      sub={project ?? undefined}
    >
      <div className="mb-6 space-y-3 rounded-xl border bg-muted/20 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SlidersHorizontal className="mr-1 size-4 text-muted-foreground" aria-hidden="true" />
          <Select value={project ?? ALL} onValueChange={(v) => pickProject(v === ALL ? null : v)}>
            <SelectTrigger aria-label="Filter statistics by project" className="w-full bg-background sm:w-[12rem]"><Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>All projects</SelectItem>{options.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={repo ?? ALL} onValueChange={(v) => pickRepo(v === ALL ? null : v)}>
            <SelectTrigger aria-label="Filter statistics by repository" className="w-full bg-background sm:w-[16rem]"><GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>All repositories</SelectItem>{repoOptions.filter(r => r !== "—").map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
          </Select>
          {(project || repo) && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="size-4" aria-hidden="true" />Clear</Button>}
        </div>
        <div className="border-t pt-3"><DateRangePicker value={range} onChange={setRange} /></div>
      </div>
      {error && !data ? (
        <Card><CardContent className="p-4">
          <EmptyState
            title="Failed to load stats"
            hint={error}
            action={<Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}><RefreshCw className="size-4" aria-hidden="true" />Try again</Button>}
          />
        </CardContent></Card>
      ) : !data ? (
        <>
          <CardsSkeleton count={3} />
          <div className="mt-6"><Skeleton className="h-[300px] w-full rounded-lg" /></div>
        </>
      ) : (
        <>
          {error && <p className="mb-3 text-sm text-destructive" role="status">Refresh failed · showing last readings.</p>}
          {/* The host selector lives above the cards, independent of the "Daily trend" section (which
              is hidden for a 1-day range) — otherwise it would vanish entirely on the default "today" view. */}
          {hosts.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">Overview</span>
              <Tabs value={effHost} onValueChange={(v) => setHost(v as HostFilter)}>
                <TabsList>
                  <TabsTrigger value="all">All</TabsTrigger>
                  {hosts.map((h) => <TabsTrigger key={h} value={h}>{hostLabel(h)}</TabsTrigger>)}
                </TabsList>
              </Tabs>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard kind="cost" value={czCurrency(shownTotals!.cost)} change={delta(shownTotals!.cost, shownPrevious!.cost)} />
            <MetricCard kind="tokens" value={compactNumber(shownTotals!.tokens)} change={delta(shownTotals!.tokens, shownPrevious!.tokens)} />
            <MetricCard kind="hours" value={`${shownTotals!.hours.toFixed(1)} h`} change={delta(shownTotals!.hours, shownPrevious!.hours)} />
          </div>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t pt-3 text-xs text-muted-foreground">
            <span><b className="font-medium text-foreground">{czCurrency(shownTotals!.cost / Math.max(1, days))}</b> / day</span>
            <span><b className="font-medium text-foreground">{models.length}</b> models</span>
            <span><b className="font-medium text-foreground">{repos.length}</b> repositories</span>
            <span><b className="font-medium text-foreground">{accounts.length}</b> accounts</span>
          </div>

          {/* The project filter can also be set for a period in which the project spent nothing (a link,
              a range switch). Without this notice the page would just show all zeros and
              there would be no way to tell that the filter is the cause. */}
          {(project || repo) && !hasData && (
            <Card className="mt-3"><CardContent className="p-4">
              <EmptyState
                title={`No data for ${repo ?? project} in this period`}
                hint="Try another repository or date range."
                action={<Button variant="outline" size="sm" onClick={clearFilters}><X className="size-4" aria-hidden="true" />Clear filters</Button>}
              />
            </CardContent></Card>
          )}

          <div className="h-6" />

          {/* A daily series only makes sense from two days up — for "today" it would be one bar. */}
          {days > 1 && (
            <Section
              label="Daily trend"
              meta={
                <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
                  <TabsList>{METRICS.map((x) => <TabsTrigger key={x.id} value={x.id}>{x.label}</TabsTrigger>)}</TabsList>
                </Tabs>
              }
            >
              <Card><CardContent className="p-4">
                {!chartHasData ? <EmptyState title="No data for this period" hint="Try a different date range." /> : (
                  <ChartContainer config={chartConfig} className="h-[260px] w-full">
                    <AreaChart data={chartRows}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
                      <YAxis hide domain={[0, "dataMax"]} />
                      <ChartTooltip content={<ChartTooltipContent />} formatter={(v, name) => `${hostLabel(String(name))}: ${m.fmt(Number(v))}`} />
                      {seriesHosts.map((h) => {
                        // Color by position in the alphabetical `hosts` list (not by order
                        // in dailyByHost, which the server sorts by cost) — so a host keeps
                        // the same color across ranges even when the cost order swaps.
                        const colorIdx = (hosts.indexOf(h) % 5) + 1;
                        return (
                          // `monotone`, not `natural`: a natural spline OVERSHOOTS between points,
                          // so after a zero day and a sharp jump the curve and fill dipped BELOW
                          // the x axis and the chart claimed negative spend. Monotone interpolation
                          // never leaves the range of the input values while staying
                          // smooth. DO NOT switch back to `natural`.
                          <Area key={h} dataKey={h} type="monotone" stackId="1"
                            fill={COLORS[colorIdx - 1]} fillOpacity={0.22} stroke={COLORS[colorIdx - 1]} strokeWidth={2.5} isAnimationActive={false} />
                        );
                      })}
                    </AreaChart>
                  </ChartContainer>
                )}
              </CardContent></Card>
            </Section>
          )}

          <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><span className="size-2 rounded-full bg-indigo-500" />Breakdowns · all machines{project ? ` · ${project}` : ""}{repo ? ` · ${repo}` : ""}</div>

          {/* The same active_time series as the "Active time" KPI above, just broken down by hour
              of day — it sits right next to "Work hours" (a different quantity), hence Active in the title too. */}
          <Section
            label="By hour of day"
            meta={<div className="flex flex-wrap items-center gap-3">
              {peak !== null && <span className="text-xs text-muted-foreground">Peak {hourLabel(peak)}</span>}
              <Tabs value={hourlyMetric} onValueChange={(value) => setHourlyMetric(value as "hours" | "cost")}><TabsList><TabsTrigger value="hours">Active time</TabsTrigger><TabsTrigger value="cost">Cost</TabsTrigger></TabsList></Tabs>
            </div>}
          >
            <Card><CardContent className="p-4">
              {!hasData ? <EmptyState title="Nothing worked in this period" /> : (
                <ChartContainer config={chartConfig} className="h-[220px] w-full">
                  <LineChart data={data.hourly.map((h) => ({ hour: hourLabel(h.hour), value: h[hourlyMetric] }))}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="hour" tickLine={false} axisLine={false} tickMargin={8} interval={2} />
                    {/* Without an explicit axis recharts picks a domain that flattens the bars
                        to a few pixels — the domain has to come from the data. */}
                    <YAxis hide domain={[0, "dataMax"]} />
                    <ChartTooltip content={<ChartTooltipContent />} formatter={(v) => hourlyMetric === "cost" ? czCurrency(Number(v)) : `${Number(v).toFixed(1)} h`} />
                    <Line dataKey="value" type="linear" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3, fill: "#6366f1", strokeWidth: 0 }} activeDot={{ r: 5 }} isAnimationActive={false} />
                  </LineChart>
                </ChartContainer>
              )}
            </CardContent></Card>
          </Section>

          <Section
            label="Work hours"
            meta={<span className="text-sm text-muted-foreground">Prompt → completion</span>}
          >
            <Card><CardContent className="p-4">
              {workError && work && <p className="mb-3 text-sm text-destructive" role="status">Refresh failed · showing last readings.</p>}
              {workError && !work ? (
                <EmptyState title="Failed to load work hours" hint={workError} />
              ) : !work ? (
                <Skeleton className="h-24 w-full" />
              ) : shownWork!.byProject.length === 0 ? (
                <EmptyState title={project ? `No tracked work for ${project} in this period` : "No tracked work in this period"} />
              ) : (
                <>
                  <div className="mb-4 text-3xl font-semibold tabular-nums text-cyan-700 dark:text-cyan-400">{formatHours(shownWork!.totalHours)}</div>
                  {!project && days > 1 && work.daily.length > 1 && (
                    <ChartContainer config={chartConfig} className="mb-4 h-[160px] w-full">
                      <BarChart data={work.daily.map((d) => ({ day: dayLabel(d.day), value: d.hours }))}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={24} />
                        <YAxis hide domain={[0, "dataMax"]} />
                        <ChartTooltip content={<ChartTooltipContent />} formatter={(v) => formatHours(Number(v))} />
                        <Bar dataKey="value" fill="#06b6d4" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                      </BarChart>
                    </ChartContainer>
                  )}
                  <ScrollX>
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Project</TableHead>
                        <TableHead className="text-right">Hours</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {shownWork!.byProject.map((p) => (
                          <TableRow key={p.project}>
                            <TableCell className="font-medium">
                              {p.project}
                              {cappedNote(p) && <span title={cappedNote(p) ?? undefined} className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">Capped</span>}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{formatHours(p.hours)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollX>
                </>
              )}
            </CardContent></Card>
          </Section>

          <Section label="Prompt patterns">
            <Card><CardContent className="p-4">
              <ScrollX>
                <Table>
                  <TableHeader><TableRow><TableHead>Metric</TableHead><TableHead className="text-right">Samples</TableHead><TableHead className="text-right">Avg.</TableHead><TableHead className="text-right">Median</TableHead><TableHead className="text-right" title="90th percentile">P90</TableHead></TableRow></TableHeader>
                  <TableBody>
                    <TableRow><TableCell className="font-medium">Prompt length <span className="font-normal text-muted-foreground">· characters</span></TableCell>
                      <TableCell className="text-right tabular-nums">{czInt(data.prompts.chars.count)}</TableCell>
                      <TableCell className="text-right tabular-nums">{data.prompts.chars.count ? czInt(data.prompts.chars.avg) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{quantileLabel(data.prompts.chars, czInt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{data.prompts.chars.count ? czInt(data.prompts.chars.p90) : "—"}</TableCell>
                    </TableRow>
                    <TableRow><TableCell className="font-medium">Between prompts</TableCell>
                      <TableCell className="text-right tabular-nums">{czInt(data.prompts.waitMs.count)}</TableCell>
                      <TableCell className="text-right tabular-nums">{data.prompts.waitMs.count ? msLabel(data.prompts.waitMs.avg) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{quantileLabel(data.prompts.waitMs, msLabel)}</TableCell>
                      <TableCell className="text-right tabular-nums">{data.prompts.waitMs.count ? msLabel(data.prompts.waitMs.p90) : "—"}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </ScrollX>

            </CardContent></Card>
          </Section>

          {/* The server deliberately does not filter the project leaderboard — it is both a selector
              (click = filter) and context for how much of the total a project takes. */}
          <div className="grid items-start gap-x-6 lg:grid-cols-2">
            <Leaderboard title="Projects" rows={projects} unit="project" onPick={pickProject} active={project} />
            <Leaderboard title="Repositories" rows={repos} unit="repository" onPick={pickRepo} active={repo} />
          </div>
          <Leaderboard title="Models" rows={models} unit="model" />

          <Section label="By account">
            <Card><CardContent className="p-4">
              {accounts.length === 0 ? <EmptyState title="No account data" /> : (
                <ScrollX>
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead className="text-right">Active time</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {accounts.map((a, i) => (
                        <TableRow key={a.key}>
                          {/* A uuid is unreadable for humans; shortening is enough until the pool provides a label.
                              The "—" bucket (rows without an account uuid) gets a readable Unknown instead of a dash. */}
                          <TableCell className="font-mono text-xs" title={unknownLabel(a.key)}>
                            <span className="mr-2 inline-block size-2 rounded-full" style={{backgroundColor: COLORS[i % COLORS.length]}} />{a.key === "—" ? unknownLabel(a.key) : a.key.slice(0, 8)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{czCurrency(a.cost)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{compactNumber(a.tokens)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{formatHours(a.hours)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollX>
              )}
            </CardContent></Card>
          </Section>
          <details className="rounded-lg border bg-muted/20 px-4 py-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">About these metrics</summary><div className="mt-3 grid gap-2 sm:grid-cols-2"><p>Active time: agent telemetry. Work hours: prompt to completion, capped at 30 minutes per turn.</p><p>Arrows compare the previous period. Between prompts measures idle time; P90 is the 90th percentile. Missing readings show a dash.</p></div></details>
        </>
      )}
    </AppPage>
  );
}
