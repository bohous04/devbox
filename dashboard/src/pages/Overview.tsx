import { WeeklyUsage } from "../components/WeeklyUsage";
import { CodexResets } from "../components/CodexResets";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type HardwareSnapshot, type RangeStats, type SessionLive } from "../api";
import { CountUp } from "../components/CountUp";
import { StorageSummary } from "../components/StorageSummary";
import { AppPage, CardsSkeleton, EmptyState, Section, StatCard, StatusDot } from "../components/primitives";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { presetRange } from "@/lib/range";
import { agoLabel, bytes, compactNumber, czCurrency, czInt, stateLabel } from "../format";
import { backupAge, backupStale, fillLabel } from "../hardwareView";
import { share, toRanked, totalCost } from "../statsView";
import { useStore } from "../store";

function SessionLine({ s }: { s: SessionLive }) {
  const running = s.status === "running";
  const port = s.ports[0]?.host;
  return (
    <Link to={`/sessions?open=${encodeURIComponent(s.id)}`} className="flex h-11 items-center gap-3 transition-colors hover:bg-accent/40">
      <StatusDot kind={running ? s.claudeState : "stopped"} pulse={running && s.claudeState === "working"} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name?.trim() || `${s.project}/${s.repo}`}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {running ? `${stateLabel(s.claudeState)}${port ? ` · :${port}` : ""}` : "stopped"}
      </span>
    </Link>
  );
}

/**
 * Three infrastructure numbers that used to require going to Beszel, Kuma and SSH.
 * The section is not shown at all when monitoring is not configured — empty tiles
 * on Overview would just take up space.
 */
function Infrastructure() {
  const [snap, setSnap] = useState<HardwareSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.hardware().then((d) => { if (alive) setSnap(d); }).catch(() => { if (alive) setSnap(null); });
    load();
    const h = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  if (!snap) return null;

  const now = Date.now();
  const withBackup = snap.machines.filter((m) => m.backup);
  const stale = withBackup.filter((m) => backupStale(m, now));
  const newest = withBackup
    .map((m) => backupAge(m, now))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b)[0];
  const down = snap.monitors.filter((m) => !m.up);
  const box = snap.storageBox;

  return (
    <Section
      label="Infrastructure"
      meta={<Link to="/hardware" className="text-sm text-muted-foreground hover:text-foreground">hardware →</Link>}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Services"
          value={down.length === 0 ? `${snap.monitors.length} up` : `${down.length} down`}
          sub={down.length === 0 ? "all monitors responding" : down.map((m) => m.name).join(", ")}
          tone={down.length === 0 ? "ok" : "warn"}
        />
        <StatCard
          label="Backups"
          value={newest === undefined ? "never" : agoLabel(newest)}
          sub={stale.length === 0
            ? `${withBackup.length} machine${withBackup.length === 1 ? "" : "s"} backed up daily`
            : `stale: ${stale.map((m) => m.label).join(", ")}`}
          tone={stale.length === 0 ? "ok" : "warn"}
        />
        <StatCard
          label="Storage Box"
          value={box ? bytes(box.usedBytes) : "—"}
          sub={box ? `of ${bytes(box.totalBytes)} · ${fillLabel(box.usedBytes, box.totalBytes)}` : "off-site borg repo"}
        />
      </div>
    </Section>
  );
}

export function Overview() {
  const { live, totals, disk, config } = useStore();
  // Overview is a view of TODAY, not of history — browsing periods is what Stats is for.
  // A time picker here only tempted people to read the tiles as "for the period", even though half
  // of them (Cost 30 days, Commits today, Disk) never listened to the range anyway.
  const [range, setRange] = useState(() => presetRange("today", Date.now()));
  const [stats, setStats] = useState<RangeStats | null>(null);

  // The dashboard is often open across midnight. While the picker was here, a frozen "today"
  // could be switched manually; now it must move by itself, otherwise in the morning it would show yesterday.
  // `presetRange` is aligned to midnight, so the value changes only at the day boundary.
  useEffect(() => {
    const t = setInterval(() => {
      const r = presetRange("today", Date.now());
      setRange((prev) => (prev.from === r.from && prev.to === r.to ? prev : r));
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    setStats(null);
    api.statsRange(range.from, range.to).then((d) => { if (alive) setStats(d); }).catch(() => { if (alive) setStats(null); });
    return () => { alive = false; };
  }, [range.from, range.to]);

  const sessions = live?.sessions ?? [];
  const active = [...sessions]
    .sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || b.last_active_at - a.last_active_at)
    .slice(0, 6);
  const working = sessions.filter((s) => s.status === "running" && s.claudeState === "working").length;

  const projects = toRanked(stats?.projects ?? [], "project").slice(0, 5);
  const projectsTotal = totalCost(toRanked(stats?.projects ?? [], "project"));

  return (
    <AppPage
      title="Overview"
      sub="What the agents did and how the machine is doing."
    >
      <Section
        label="Today"
        meta={working > 0 && <span className="text-sm text-muted-foreground">{working}× working right now</span>}
      >
        {!stats ? <CardsSkeleton count={5} className="sm:grid-cols-3 lg:grid-cols-5" /> : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {/* The same active_time telemetry as on Stats — "Hours worked" would collide
                with Work hours (wall-clock) there, even though it is a different page. */}
            <StatCard label="Active time" value={<CountUp value={stats.totals.hours} format={(v) => v.toFixed(1)} />} unit="h" />
            <StatCard label="Tokens" value={<CountUp value={stats.totals.tokens} format={compactNumber} />} />
            <StatCard label="Cost" value={<CountUp value={stats.totals.cost} format={czCurrency} />} />
            <StatCard
              label="Cost 30 days"
              value={totals ? <CountUp value={totals.costMonth} format={czCurrency} /> : <Skeleton className="h-7 w-16" />}
            />
            <StatCard
              label="Commits today"
              value={totals ? <CountUp value={totals.commitsToday} format={czInt} /> : <Skeleton className="h-7 w-12" />}
              sub={totals && totals.unpushed > 0 ? `${totals.unpushed} unpushed` : undefined}
              tone={totals && totals.unpushed > 0 ? "warn" : undefined}
            />
          </div>
        )}
      </Section>

      <WeeklyUsage />
      <div className="mb-6"><CodexResets /></div>
      <Section label="Workspace storage" meta={<Link to="/hardware" className="text-sm text-muted-foreground hover:text-foreground">Hardware →</Link>}>
        <StorageSummary disk={disk} warning={config?.settings?.diskWarnPercent ?? 80} />
      </Section>

      <Infrastructure />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          label="Live sessions"
          meta={<Link to="/sessions" className="text-sm text-muted-foreground hover:text-foreground">all →</Link>}
        >
          <Card><CardContent className="p-4">
            {!live ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
              : active.length === 0
                ? <EmptyState title="No sessions" hint="Start one from the Sessions page or the dev command." />
                : <div className="divide-y">{active.map((s) => <SessionLine key={s.id} s={s} />)}</div>}
          </CardContent></Card>
        </Section>

        <Section
          label="Projects"
          meta={<Link to="/stats" className="text-sm text-muted-foreground hover:text-foreground">stats →</Link>}
        >
          <Card><CardContent className="p-4">
            {!stats ? <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
              : projects.length === 0
                ? <EmptyState icon="▤" title="No activity in this period" hint="Spend by project shows up once agents start working." />
                : (
                  <div className="space-y-2.5">
                    {projects.map((p, i) => (
                      <div key={p.key} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3">
                        <span className="font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium" title={p.key}>{p.key}</div>
                          <div className="mt-1 h-1.5 rounded-full bg-muted">
                            <div className={cn("h-full rounded-full bg-[var(--chart-1)]")} style={{ width: `${share(p.cost, projectsTotal)}%` }} />
                          </div>
                        </div>
                        <div className="text-right font-mono text-sm tabular-nums">
                          {czCurrency(p.cost)}
                          <div className="text-xs text-muted-foreground">{compactNumber(p.tokens)} tok</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
          </CardContent></Card>
        </Section>
      </div>
    </AppPage>
  );
}
