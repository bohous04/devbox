import { useCallback, useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Check, Copy, Download, HardDrive, Loader2, Play, Power, RefreshCw } from "lucide-react";
import { api, type HardwareSnapshot, type Machine, type MachineSample, type Monitor, type Resources, type SeriesRange } from "../api";
import { StorageSummary } from "../components/StorageSummary";
import {
  ActionButton, AppPage, CardsSkeleton, ConfirmButton, EmptyState, ScrollX, Section, StatCard, StatGrid, StatusDot,
} from "../components/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agoLabel, bytes, czPercent, durationLabel, pctOf } from "../format";
import {
  METRICS, SERIES_RANGES, attentionItems, backupAge, backupStale, backupTone, certTone, chartDomain,
  disruptiveUpdates, fillLabel, groupMonitors, memTooltip, kernelUpdates, machineDot, rebootBanner, timeLabel, toChart,
  sortResources, uptimeLabel, type MetricKey, type ResourceSort,
} from "../hardwareView";
import { cn } from "@/lib/utils";
import { useStore } from "../store";

const chartConfig: ChartConfig = {
  a: { label: "Value", color: "var(--chart-1)" },
  b: { label: "Upload", color: "var(--chart-2)" },
};

const when = (at: number | null, now: number) => (at === null ? "—" : agoLabel(now - at));

/* ---------------------------- machine picker ----------------------------- */

function MachineCard({ m, selected, onSelect }: { m: Machine; selected: boolean; onSelect: () => void }) {
  const attention = attentionItems(m);
  const pct = (v: number | undefined) => (v === undefined ? "—" : czPercent(v));
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/40",
        selected && "border-primary ring-1 ring-primary",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot kind={machineDot(m)} pulse={machineDot(m) === "danger"} />
        <span className="min-w-0 flex-1 truncate font-medium">{m.label}</span>
        {attention.length > 0 && <Badge variant="secondary" className="flex-none">{attention.length} to check</Badge>}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-sm tabular-nums">
        {[
          ["CPU", pct(m.beszel?.cpu)],
          ["RAM", pct(m.beszel?.memPct)],
          ["Disk", pct(m.beszel?.diskPct)],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="font-sans text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
            <div>{value}</div>
          </div>
        ))}
      </div>
      {attention.length > 0 && (
        <div className="mt-3 border-t pt-2 text-xs text-amber-600 dark:text-amber-500">
          ⚠ {attention.join(" · ")}
        </div>
      )}
    </button>
  );
}

/* --------------------------------- grafy -------------------------------- */

function Charts({ machineId }: { machineId: string }) {
  const [range, setRange] = useState<SeriesRange>("6h");
  const [metric, setMetric] = useState<MetricKey>("cpu");
  const [samples, setSamples] = useState<MachineSample[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSamples(null);
    setError(null);
    api.hardwareSeries(machineId, range)
      .then((s) => { if (alive) setSamples(s); })
      .catch((e) => { if (alive) { setSamples([]); setError((e as Error).message); } });
    return () => { alive = false; };
  }, [machineId, range]);

  const unit = METRICS.find((x) => x.key === metric)!.unit;
  const data = samples ? toChart(samples, metric).map((p) => ({ ...p, t: timeLabel(p.at, range) })) : [];

  return (
    <Section
      label="History"
      meta={
        <Tabs value={range} onValueChange={(v) => setRange(v as SeriesRange)}>
          <TabsList>{SERIES_RANGES.map((r) => <TabsTrigger key={r.key} value={r.key}>{r.label}</TabsTrigger>)}</TabsList>
        </Tabs>
      }
    >
      <Card><CardContent className="p-4">
        <Tabs value={metric} onValueChange={(v) => setMetric(v as MetricKey)} className="mb-3">
          <TabsList>{METRICS.map((x) => <TabsTrigger key={x.key} value={x.key}>{x.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        {samples === null ? <Skeleton className="h-[240px] w-full" />
          : data.length === 0
            ? <EmptyState title="No data for this window" hint={error ?? "Beszel keeps a few hours of fine-grained history; a freshly added agent needs a moment."} />
            : (
              <ChartContainer config={chartConfig} className="h-[240px] w-full">
                <AreaChart data={data}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="t" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
                  {/* Without an explicit axis recharts picks a domain that flattens the curve
                      to a few pixels — the domain must come from the data. */}
                  <YAxis hide domain={chartDomain(metric, samples ?? [])} />
                  <ChartTooltip content={<ChartTooltipContent />} formatter={(v, name, item) => metric === "mem" ? memTooltip(String(name), Number(v), item.payload) : `${Number(v).toFixed(1)} ${unit}${name === "b" ? " up" : metric === "net" ? " down" : ""}`} />
                  <Area dataKey="a" type="monotone" fill="var(--chart-1)" fillOpacity={0.2} stroke="var(--chart-1)" />
                  {(metric === "net" || metric === "mem") && <Area dataKey="b" type="monotone" fill="var(--chart-2)" fillOpacity={0.15} stroke="var(--chart-2)" />}
                </AreaChart>
              </ChartContainer>
            )}
      </CardContent></Card>
    </Section>
  );
}

/* -------------------------------- backups -------------------------------- */

function CopyLine({ label, command }: { label: string; command: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1800);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex items-stretch gap-2">
        {/* min-w-0 is required: without it a flex item does not shrink below its content width, so
            a long rsync command would stretch the page instead of scrolling inside. */}
        <ScrollX className="min-w-0 flex-1 rounded-md border bg-muted/40 px-3 py-2">
          <code className="whitespace-pre font-mono text-xs">{command}</code>
        </ScrollX>
        <Button
          variant="outline"
          size="sm"
          className="flex-none self-stretch"
          onClick={() => { navigator.clipboard?.writeText(command); setDone(true); }}
        >
          {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function Backup({ m, now, onRan }: { m: Machine; now: number; onRan: () => void }) {
  const b = m.backup;
  if (!b) {
    return (
      <Section label="Backup">
        <EmptyState icon="▤" title="This machine has no backup configured" />
      </Section>
    );
  }
  const repo = b.repo;
  const stale = backupStale(m, now);
  const age = backupAge(m, now);
  return (
    <Section
      label="Backup"
      meta={b.nextAt !== null && b.nextAt > now && (
        <span className="text-sm text-muted-foreground">next in {durationLabel(b.nextAt - now)}</span>
      )}
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard
          label="Last run"
          value={age === null ? "never" : agoLabel(age)}
          sub={b.state === "running" ? "running now" : b.message ?? b.state}
          tone={stale || backupTone(b.state) === "danger" ? "warn" : backupTone(b.state) === "ok" ? "ok" : undefined}
        />
        <StatCard label="Archives" value={repo ? repo.archives.length : "—"} sub="kept by retention" />
        <StatCard label="Repo size" value={repo ? bytes(repo.storedBytes) : "—"} sub={repo ? `${bytes(repo.originalBytes)} before dedup` : undefined} />
        <StatCard
          label="Duration"
          value={b.startedAt && b.finishedAt && b.finishedAt > b.startedAt ? durationLabel(b.finishedAt - b.startedAt) : "—"}
          sub="of the last run"
        />
      </div>

      <Card className="mt-3"><CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <ActionButton
            variant="outline"
            size="sm"
            icon={<Play className="h-4 w-4" />}
            onAction={async () => { await api.runBackup(m.id); onRan(); }}
            disabled={b.state === "running"}
          >
            {b.state === "running" ? "Running…" : "Back up now"}
          </ActionButton>
          <span className="text-xs text-muted-foreground">
            Runs in the background; the result shows up here within a few minutes.
          </span>
        </div>

        {b.pull.length > 0 && (
          <div className="space-y-3 border-t pt-4">
            <div className="text-xs text-muted-foreground">
              Downloading means copying the whole borg repository
              {repo ? ` (${bytes(repo.storedBytes)})` : ""} — a single archive exported as a tar
              would be the full uncompressed size. Run this outside the dashboard so it can resume.
            </div>
            {b.pull.map((p) => <CopyLine key={p.label} label={p.label} command={p.command} />)}
          </div>
        )}

        {repo && repo.archives.length > 0 && (
          <div className="border-t pt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Recent archives</div>
            <div className="divide-y">
              {repo.archives.slice(0, 5).map((a) => (
                <div key={a.id} className="flex h-9 items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{a.name}</span>
                  <span className="flex-none text-xs text-muted-foreground">{when(a.at, now)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent></Card>
    </Section>
  );
}

/* ------------------------ aktualizace a aktivita ------------------------- */

/**
 * Reboot is the only irreversible action on this page and on the devbox it also takes
 * the running agents with it, so it must be visible what is being cut — the number of live sessions
 * comes from the store (for a remote machine it makes no sense, there are none there).
 */
function RebootButton({ m, onDone }: { m: Machine; onDone: () => void }) {
  const { live } = useStore();
  const running = m.id === "devbox" ? (live?.sessions ?? []).filter((s) => s.status === "running").length : 0;
  return (
    <ConfirmButton
      variant="outline"
      size="default"
      confirmLabel={running > 0 ? `Reboot anyway — ${running} running` : "Reboot now?"}
      onConfirm={async () => { await api.rebootHost(m.id); onDone(); }}
    >
      <Power className="h-4 w-4" />
      Reboot
    </ConfirmButton>
  );
}

function Updates({ m, onAction, onRebooted }: { m: Machine; onAction: () => void; onRebooted: () => void }) {
  const h = m.host;
  if (!h) return null;
  const none = !h.rebootRequired && h.updates.length === 0;
  const upgrading = m.upgrade?.state === "running";
  const { live } = useStore();
  const running = m.id === "devbox" ? (live?.sessions ?? []).filter((s) => s.status === "running").length : 0;
  const disruptive = disruptiveUpdates(h.updates);
  const kernel = kernelUpdates(h.updates);
  return (
    <Section
      label="Updates"
      meta={h.rebootRequired && <Badge variant="destructive">reboot required</Badge>}
    >
      <Card><CardContent className="space-y-4 p-4">
        {none ? (
          <div className="text-sm text-muted-foreground">Everything is up to date and no reboot is pending.</div>
        ) : (
          <>
            {h.rebootRequired && (
              <div className="text-sm">
                A reboot is pending{h.rebootPkgs.length > 0 ? ` because of ${h.rebootPkgs.join(", ")}` : ""}.
                {" "}Nothing reboots on its own — do it when it suits you.
              </div>
            )}
            {h.updates.length > 0 && (
              <div>
                <div className="mb-2 text-sm">{h.updates.length} package{h.updates.length === 1 ? "" : "s"} can be upgraded.</div>
                <div className="divide-y">
                  {h.updates.map((u) => (
                    <div key={u.pkg} className="flex h-9 items-center gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate font-medium">{u.pkg}</span>
                      {/* `flex-none` would forbid shrinking and Debian versions
                          (5:29.6.1-1~debian.13~trixie) would overflow out of the
                          page on a phone. Shrinking alone is not enough though: flexbox shrinks by
                          content length, so a long version pushed the package name out entirely.
                          A 55 % cap keeps the name always readable — on a phone it is
                          more important than the exact version. */}
                      <span className="max-w-[55%] shrink-0 truncate text-right font-mono text-xs text-muted-foreground">{u.from} → {u.to}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* A docker upgrade restarts containers. The warning must be VISIBLE before
            anyone touches the button — not only in the caption next to it. */}
        {disruptive.length > 0 && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
            <div className="font-medium">This upgrade restarts the container runtime.</div>
            <div className="mt-1 text-muted-foreground">
              {disruptive.join(", ")} — installing {disruptive.length === 1 ? "it" : "these"} restarts Docker, which
              bounces every container on this machine
              {running > 0 && <> and kills whatever the {running} running session{running === 1 ? "" : "s"} {running === 1 ? "is" : "are"} doing</>}.
              {" "}Containers with a restart policy come back; databases started by hand do not.
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          {disruptive.length > 0 ? (
            <ConfirmButton
              variant="outline"
              size="default"
              confirmLabel={running > 0 ? `Restart containers — ${running} session${running === 1 ? "" : "s"} live?` : "Restart containers?"}
              onConfirm={async () => { await api.runUpdate(m.id); onAction(); }}
            >
              <Download className="h-4 w-4" />
              Install {h.updates.length} updates
            </ConfirmButton>
          ) : (
            <ActionButton
              variant="outline"
              icon={<Download className="h-4 w-4" />}
              disabled={upgrading || h.updates.length === 0}
              onAction={async () => { await api.runUpdate(m.id); onAction(); }}
            >
              {upgrading ? "Installing…" : h.updates.length > 0 ? `Install ${h.updates.length} updates` : "Nothing to install"}
            </ActionButton>
          )}
          <RebootButton m={m} onDone={() => { onRebooted(); onAction(); }} />
          <span className="text-xs text-muted-foreground">
            {upgrading
              ? "apt is running detached — it keeps going even if you close this."
              : kernel.length > 0
                ? "The new kernel only takes effect after a reboot — installing it changes nothing on its own."
                : running > 0
                  ? `${running} session${running === 1 ? "" : "s"} running on this machine; a reboot interrupts them.`
                  : "Updates install in the background; a reboot needs the second click."}
          </span>
        </div>

        {m.upgrade && m.upgrade.state === "failed" && (
          <div className="text-sm text-red-600 dark:text-red-400">
            The last upgrade failed{m.upgrade.message ? ` (${m.upgrade.message})` : ""}. Check
            {" "}<code className="font-mono text-xs">journalctl -u devd-apt-upgrade</code> on the machine.
          </div>
        )}
      </CardContent></Card>
    </Section>
  );
}

/** Who holds RAM and CPU on the devbox. devd refreshes docker stats every 15 s, no need for more. */
function SessionResources() {
  const [data, setData] = useState<Resources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<ResourceSort>("mem");

  useEffect(() => {
    let alive = true;
    const load = () => api.resources()
      .then((r) => { if (alive) { setData(r); setError(null); } })
      .catch((e) => { if (alive) setError((e as Error).message); });
    void load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const total = data?.host.totalBytes ?? 0;
  const rows = data ? sortResources(data.sessions, sort) : [];
  const extra = data ? [
    { label: "Codex app-server", hint: "shared for all sessions", memBytes: data.codexMemBytes ?? 0, cpuPct: null as number | null },
    { label: `Other containers (${data.otherContainers.count})`, hint: "coolify, databases, runners", memBytes: data.otherContainers.memBytes, cpuPct: data.otherContainers.cpuPct },
    { label: "Host processes & cache", hint: "devd, dockerd, sshd, kernel", memBytes: data.hostOtherBytes, cpuPct: null },
  ] : [];

  return (
    <Section
      label="Sessions by resources"
      meta={
        <Tabs value={sort} onValueChange={(v) => setSort(v as ResourceSort)}>
          <TabsList><TabsTrigger value="mem">RAM</TabsTrigger><TabsTrigger value="cpu">CPU</TabsTrigger></TabsList>
        </Tabs>
      }
    >
      <Card><CardContent className="p-4">
        {data === null ? (error ? <EmptyState title="Resource breakdown unavailable" hint={error} /> : <Skeleton className="h-[240px] w-full" />) : (
          <>
            <div className="mb-3 text-xs text-muted-foreground">
              {bytes(data.host.usedBytes)} of {bytes(total)} RAM used · CPU in % of one core, 1 600 % = all 16 cores · includes each session's Docker-in-Docker
            </div>
            <div className="divide-y">
              {rows.length === 0 && <div className="py-2 text-sm text-muted-foreground">No running sessions.</div>}
              {rows.map((r) => <ResourceLine key={r.id} label={r.label} hint={r.dindMemBytes > 0 ? `${r.project} · dind ${bytes(r.dindMemBytes)}` : r.project} memBytes={r.memBytes} cpuPct={r.cpuPct} total={total} />)}
            </div>
            <div className="mt-2 divide-y border-t">
              {extra.map((x) => <ResourceLine key={x.label} label={x.label} hint={x.hint} memBytes={x.memBytes} cpuPct={x.cpuPct} total={total} muted />)}
            </div>
          </>
        )}
      </CardContent></Card>
    </Section>
  );
}

function ResourceLine({ label, hint, memBytes, cpuPct, total, muted }: { label: string; hint: string; memBytes: number; cpuPct: number | null; total: number; muted?: boolean }) {
  const share = total > 0 ? Math.min(100, (memBytes / total) * 100) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2 sm:grid-cols-[minmax(0,14rem)_1fr_5.5rem_4.5rem]">
      <div className="min-w-0">
        <div className={cn("truncate text-sm font-medium", muted && "text-muted-foreground")}>{label}</div>
        <div className="truncate text-xs text-muted-foreground">{hint}</div>
      </div>
      <div className="col-span-2 row-start-2 h-2 overflow-hidden rounded bg-muted sm:col-span-1 sm:row-start-auto" aria-hidden>
        <div className={cn("h-full rounded", muted ? "bg-muted-foreground/40" : "bg-[var(--chart-1)]")} style={{ width: `${share}%` }} />
      </div>
      <div className="col-start-2 row-start-1 text-right font-mono text-sm tabular-nums sm:col-start-auto sm:row-start-auto">{bytes(memBytes)}</div>
      <div className="hidden text-right font-mono text-sm tabular-nums text-muted-foreground sm:block">{cpuPct === null ? "—" : `${Math.round(cpuPct)} %`}</div>
    </div>
  );
}

function Activity({ m, now }: { m: Machine; now: number }) {
  const h = m.host;
  if (!h) return null;
  return (
    <Section label="Activity">
      <div className="grid gap-3 lg:grid-cols-2">
        <Card><CardContent className="p-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">SSH logins</div>
          {h.logins.length === 0 ? (
            <div className="text-sm text-muted-foreground">No logins in the last 14 days.</div>
          ) : (
            <div className="divide-y">
              {h.logins.slice(0, 8).map((l, i) => (
                <div key={`${l.at}-${i}`} className="flex h-9 items-center gap-3 text-sm">
                  <span className="flex-none font-medium">{l.user}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{l.ip} · {l.method}</span>
                  <span className="flex-none text-xs text-muted-foreground">{when(l.at, now)}</span>
                </div>
              ))}
            </div>
          )}
          {/* Honestly: what happened after login is not recorded anywhere. See spec P5/P6. */}
          <div className="mt-3 text-xs text-muted-foreground">
            Commands run over SSH are not logged anywhere — that would need auditd.
          </div>
        </CardContent></Card>

        <Card><CardContent className="p-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Package changes</div>
          {h.packages.length === 0 ? (
            <div className="text-sm text-muted-foreground">Nothing installed or upgraded recently.</div>
          ) : (
            <div className="divide-y">
              {h.packages.slice(0, 8).map((p, i) => (
                <div key={`${p.at}-${p.pkg}-${i}`} className="flex h-9 items-center gap-3 text-sm">
                  <span className="w-16 flex-none text-xs text-muted-foreground">{p.action}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{p.pkg}</span>
                  <span className="flex-none text-xs text-muted-foreground">{when(p.at, now)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent></Card>
      </div>
    </Section>
  );
}

/* -------------------------------- detail -------------------------------- */

function MachineDetail({ m, now, onRefresh }: { m: Machine; now: number; onRefresh: () => void }) {
  const h = m.host;
  const disk = h?.disk;
  // When the user last clicked Reboot on THIS machine. The only action state that the
  // server cannot carry itself: on the devbox a reboot kills devd too, so "rebooting"
  // must survive on the client. Switching to another machine unmounts the component and
  // correctly drops the state — the banner belongs to the machine that was clicked.
  const [rebootedAt, setRebootedAt] = useState<number | null>(null);
  const rebootMsg = rebootBanner(rebootedAt, h?.uptimeSec, now);
  return (
    <>
      {rebootMsg && (
        <Card className="mb-5 border-amber-500/40"><CardContent className="flex items-center gap-2 p-4 text-sm">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          <span>{rebootMsg}</span>
        </CardContent></Card>
      )}
      {m.errors.length > 0 && (
        <Card className="mb-5 border-amber-500/40"><CardContent className="p-4">
          <div className="text-sm font-medium">Some data could not be refreshed</div>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {m.errors.map((e) => <li key={e} className="break-words font-mono">{e}</li>)}
          </ul>
          <div className="mt-2 text-xs text-muted-foreground">Values below are the last ones that came through.</div>
        </CardContent></Card>
      )}

      <Section
        label="Now"
        meta={<span className="text-sm text-muted-foreground">checked {when(m.checkedAt || null, now)}</span>}
      >
        <StatGrid
          items={[
            { label: "CPU", value: m.beszel ? czPercent(m.beszel.cpu) : "—" },
            { label: "Memory", value: m.beszel ? czPercent(m.beszel.memPct) : "—" },
            { label: "Disk", value: m.beszel ? czPercent(m.beszel.diskPct) : "—" },
            { label: "Uptime", value: h?.uptimeSec ? durationLabel(h.uptimeSec * 1000) : "—" },
            { label: "Agent", value: m.beszel?.agentVersion ?? "—" },
          ]}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <StatCard label="OS" value={<span className="text-base">{h?.os ?? "—"}</span>} sub={h?.kernel ?? undefined} />
          <StatCard
            label="Disk used"
            value={disk ? bytes(disk.usedBytes) : "—"}
            sub={disk ? `${bytes(Math.max(0, disk.totalBytes - disk.usedBytes))} free · ${czPercent(pctOf(disk.usedBytes, disk.totalBytes))} used` : undefined}
          />
          <StatCard label="Hostname" value={<span className="font-mono text-base">{h?.hostname ?? "—"}</span>} />
        </div>
      </Section>

      <Charts machineId={m.id} />
      {m.id === "devbox" && <SessionResources />}
      <Backup m={m} now={now} onRan={onRefresh} />
      <Updates m={m} onAction={onRefresh} onRebooted={() => setRebootedAt(Date.now())} />
      <Activity m={m} now={now} />
    </>
  );
}

/* ------------------------------- services -------------------------------- */

function MonitorRow({ m }: { m: Monitor }) {
  const cert = certTone(m.certDaysLeft);
  return (
    <div className="flex h-11 items-center gap-3">
      <StatusDot kind={m.up ? "ok" : "danger"} pulse={!m.up} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{m.name}</div>
        {m.url && <div className="truncate text-xs text-muted-foreground">{m.url}</div>}
      </div>
      <div className="hidden flex-none text-right sm:block">
        <div className="font-mono text-sm tabular-nums">{uptimeLabel(m.uptime30d)}</div>
        <div className="text-xs text-muted-foreground">30 days</div>
      </div>
      <div className="w-20 flex-none text-right">
        <div className="font-mono text-sm tabular-nums">{m.responseMs === null ? "—" : `${m.responseMs} ms`}</div>
        {m.certDaysLeft !== null && (
          <div className={cn("text-xs text-muted-foreground", cert === "warn" && "text-amber-600 dark:text-amber-400", cert === "danger" && "text-red-600 dark:text-red-400")}>
            cert {m.certDaysLeft} d
          </div>
        )}
      </div>
    </div>
  );
}

function Services({ monitors }: { monitors: Monitor[] }) {
  const groups = groupMonitors(monitors);
  const down = monitors.filter((m) => !m.up).length;
  return (
    <Section
      label="Services"
      meta={<span className="text-sm text-muted-foreground">{down === 0 ? `all ${monitors.length} up` : `${down} down`}</span>}
    >
      {monitors.length === 0 ? (
        <EmptyState icon="◎" title="No monitors" hint="Uptime Kuma has nothing to report, or its API key is not set." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {groups.map((g) => (
            <Card key={g.tag}><CardContent className="p-4">
              <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{g.tag}</div>
              <div className="divide-y">{g.monitors.map((m) => <MonitorRow key={m.id} m={m} />)}</div>
            </CardContent></Card>
          ))}
        </div>
      )}
    </Section>
  );
}

/* -------------------------- disk devboxu (devd) -------------------------- */

/** Keep workspace usage separate from whole-filesystem monitoring above. */
function WorkspaceDisk() {
  const { disk, config } = useStore();
  return (
    <Section label="Workspace storage" meta={<span className="text-sm text-muted-foreground">/srv/dev</span>}>
      <StorageSummary disk={disk} warning={config?.settings?.diskWarnPercent ?? 80} />
    </Section>
  );
}

/* ---------------------------------- page --------------------------------- */

export function Hardware() {
  const [snap, setSnap] = useState<HardwareSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try { setSnap(await api.hardware()); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    load();
    // The snapshot on the server refreshes on its own schedule (see INTERVALS in hardware.ts);
    // this is just a pull from the cache, so it can be frequent without load on SSH.
    const h = setInterval(() => { load(); setNow(Date.now()); }, 20_000);
    return () => clearInterval(h);
  }, [load]);

  const machines = snap?.machines ?? [];
  const current = machines.find((m) => m.id === selected) ?? machines[0] ?? null;
  const box = snap?.storageBox ?? null;

  return (
    <AppPage
      title="Hardware"
      sub="Machines, storage, backups and the services they run."
      actions={
        <ActionButton variant="outline" size="sm" icon={<RefreshCw className="h-4 w-4" />} onAction={load}>
          Refresh
        </ActionButton>
      }
    >
      {error && !snap && (
        <EmptyState
          icon="▚"
          title="Monitoring is not available"
          hint={`${error}. Beszel, Uptime Kuma and the remote SSH key (remoteSsh) live in /etc/devd/secrets.json.`}
        />
      )}

      {!snap && !error && <CardsSkeleton count={2} className="sm:grid-cols-2 lg:grid-cols-3" />}

      {snap && (
        <>
          <Section
            label="Machines"
            meta={<span className="text-sm text-muted-foreground">updated {when(snap.updatedAt || null, now)}</span>}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {machines.map((m) => (
                <MachineCard key={m.id} m={m} selected={m.id === current?.id} onSelect={() => setSelected(m.id)} />
              ))}
              {box && (
                <div className="rounded-xl border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-4 w-4 flex-none text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">Storage Box</span>
                  </div>
                  {/* The main number is bytes, not percent — the repo takes 0.19 % of the quota
                      and "0 %" would look like an error. */}
                  <div className="mt-3 font-mono text-2xl font-semibold tabular-nums">
                    {bytes(box.usedBytes)}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    of {bytes(box.totalBytes)} · {fillLabel(box.usedBytes, box.totalBytes)} · off-site borg repo
                  </div>
                </div>
              )}
            </div>
          </Section>

          {snap.errors.length > 0 && (
            <Card className="mb-5 border-amber-500/40"><CardContent className="p-4">
              <div className="text-sm font-medium">Integrations reporting problems</div>
              <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                {snap.errors.map((e) => <li key={e} className="break-words">{e}</li>)}
              </ul>
            </CardContent></Card>
          )}

          {current && <MachineDetail m={current} now={now} onRefresh={load} />}

          <Services monitors={snap.monitors} />
        </>
      )}
      <WorkspaceDisk />
    </AppPage>
  );
}
