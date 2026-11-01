import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { DateRangePicker } from "./DateRangePicker";
import { presetRange } from "../lib/range";
import { isChartedWindow, mergeUsageSeries, usageChartPoints, usageResetMarkers, USAGE_COLORS as COLORS } from "../usageView";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { useNow } from "../store";
import type { UsageResponse } from "../../../shared/usage";

const PROVIDERS = { claude: "Claude", codex: "Codex", grok: "Grok", agy: "Antigravity" };
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const dateTime = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function WeeklyUsage() {
  const [range, setRange] = useState(() => presetRange("7d", Date.now()));
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  const now = useNow(60_000);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/usage?from=${range.from}&to=${Math.min(range.to, Date.now())}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Could not load weekly limits.");
        const result = await response.json() as UsageResponse;
        if (!controller.signal.aborted) { setData(result); setError(null); }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    };
    void load(); const timer = setInterval(load, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [range.from, range.to, reload]);
  const series = (data?.accounts ?? []).filter((a) => !a.archived || a.history.length > 0 || a.resets.length > 0).flatMap((a) => {
    const windows = [...new Set([...a.latest, ...a.history, ...a.resets].map((p) => p.window))]
      .filter((w) => isChartedWindow(a.provider, a.accountLabel, w));
    if (!windows.length && !isChartedWindow(a.provider, a.accountLabel, "weekly")) return [];
    return (windows.length ? windows : ["weekly"]).map((window) => ({
      ...a, window, key: JSON.stringify([a.provider, a.accountId, a.identityKey, window]),
      label: `${PROVIDERS[a.provider]} · ${a.accountLabel}${windows.length > 1 ? ` · ${window.replaceAll("_", " ")}` : ""}`,
      points: usageChartPoints(a.history, window),
      resetsAt: usageResetMarkers(a.history, window, range.from, range.to, a.resets),
      latestPoint: a.latest.find((p) => p.window === window),
    }));
  });
  const colors = new Map(series.map((s, i) => [s.key, COLORS[i % COLORS.length]]));
  const colorFor = (key: string) => colors.get(key)!;
  const visible = series.filter((s) => !hidden.has(s.key));
  const rows = mergeUsageSeries(series);
  return <section aria-labelledby="weekly-title" className="mb-6">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 id="weekly-title" className="text-base font-semibold">Weekly plan usage</h2><p className="mt-1 text-xs text-muted-foreground">All accounts in one view · click the legend to show or hide a line</p></div><DateRangePicker value={range} onChange={setRange} /></div>
    <Card><CardContent className="p-4 sm:p-5">
      {error && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm text-destructive">{error}<Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>Retry</Button></div>}
      {!data && !error ? <p className="py-16 text-center text-sm text-muted-foreground">Loading weekly limits…</p> : <>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Accounts legend">
          {series.map((s, i) => <button key={s.key} type="button" aria-pressed={!hidden.has(s.key)} onClick={() => setHidden((prev) => { const next = new Set(prev); if (next.has(s.key)) next.delete(s.key); else next.add(s.key); return next; })} className={`flex min-h-11 items-center gap-2 rounded-md border px-3 text-xs focus-visible:outline-2 focus-visible:outline-ring ${hidden.has(s.key) ? "opacity-45" : "bg-muted/40"}`}><span className="size-2 rounded-full" style={{background:colorFor(s.key)}} />{s.label}</button>)}
          {hidden.size > 0 && <Button variant="ghost" size="sm" onClick={() => setHidden(new Set())}>Show all</Button>}
        </div>
        <div className="mt-5 h-64 min-w-0" role="img" aria-label="Weekly limits from zero to one hundred percent for selected accounts. Dashed lines mark reported resets.">
          <ResponsiveContainer width="100%" height="100%" initialDimension={{width:320,height:256}}><LineChart data={rows} margin={{top:12,right:12,left:0,bottom:0}}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="sampledAt" type="number" domain={[range.from, Math.min(range.to, now)]} allowDataOverflow scale="time" tickFormatter={(t) => range.to - range.from <= 2 * 86400_000 ? new Date(t).toLocaleTimeString(undefined, {hour:"2-digit",minute:"2-digit"}) : date(t)} axisLine={false} tickLine={false} minTickGap={45} tick={{fontSize:11}} />
            <YAxis domain={[0,100]} ticks={[0,25,50,75,100]} tickFormatter={(n) => `${n}%`} axisLine={false} tickLine={false} width={42} tick={{fontSize:11}} />
            <Tooltip labelFormatter={(t) => dateTime(Number(t))} formatter={(v, name) => [`${v}%`, name]} itemSorter={(item) => -Number(item.value)} contentStyle={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:8,fontSize:12}} />
            {series.filter((s) => !hidden.has(s.key)).flatMap((s) => s.resetsAt.map((t) => <ReferenceLine key={`${s.key}:${t}`} x={t} stroke={colorFor(s.key)} strokeOpacity={0.5} strokeDasharray="3 4" />))}
            {series.map((s,i) => <Line key={s.key} name={s.label} hide={hidden.has(s.key)} dataKey={(row: typeof rows[number]) => row.values[s.key]} type="stepAfter" stroke={colorFor(s.key)} strokeWidth={2} strokeDasharray={i >= COLORS.length ? "5 3" : undefined} dot={{r:1.5,strokeWidth:0,fill:colorFor(s.key)}} connectNulls={false} isAnimationActive={false} />)}
          </LineChart></ResponsiveContainer>
        </div>
        {!visible.some((s) => s.points.length) && <p className="mt-2 text-center text-sm text-muted-foreground">{series.length && !visible.length ? "All accounts are hidden. Select an account above." : "No weekly readings in this period. History begins with the first available measurement."}</p>}
        <p className="mt-3 text-xs text-muted-foreground">Dashed lines mark quota resets. Gaps indicate missing readings. Only weekly limits are included.</p>
      </>}
    </CardContent></Card>
    {series.some((s) => !s.archived) && <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{series.filter((s) => !s.archived).map((s) => {
      const p = s.latestPoint;
      const fresh = s.state === "ok" && p && now - p.sampledAt < 15 * 60_000 && (p.resetsAt === null || p.resetsAt > now);
      return <Card key={s.key}><CardContent className="p-4"><div className="flex items-center gap-2 text-sm font-medium"><span className="size-2 shrink-0 rounded-full" style={{background:colorFor(s.key)}} /><span className="break-words">{s.label}</span></div><div className="mt-4 flex items-baseline justify-between gap-2"><span className="text-2xl font-semibold tabular-nums">{p ? `${Math.round(p.percentUsed)}%` : "—"}</span><span className="text-xs text-muted-foreground">{fresh ? "used this week" : p ? "last measured · stale" : "no weekly reading"}</span></div><div className="my-3 h-1.5 overflow-hidden rounded-full bg-muted">{p && <div className="h-full rounded-full" style={{width:`${p.percentUsed}%`,background:colorFor(s.key),opacity:fresh?1:0.45}} />}</div><p className="text-xs text-muted-foreground">{p?.resetsAt ? `${p.resetsAt <= now ? "Reset was due" : "Resets"} ${dateTime(p.resetsAt)}` : "Reset time unavailable"}</p>{!fresh && <p className="mt-2 text-xs text-muted-foreground">{s.detail}</p>}</CardContent></Card>;
    })}</div>}
  </section>;
}
