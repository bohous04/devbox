import type { DiskStats } from "../api";
import { bytes } from "../format";
import { Card, CardContent } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { cn } from "@/lib/utils";

/** /srv/dev usage is measured with du, not filesystem-wide free space. */
export function StorageSummary({ disk, warning = 80 }: { disk: DiskStats | null; warning?: number }) {
  if (!disk) return <Card><CardContent className="p-5"><Skeleton className="h-24 w-full" /></CardContent></Card>;
  const knownCapacity = disk.totalBytes > 0;
  const percent = knownCapacity ? Math.min(100, Math.max(0, disk.usedBytes / disk.totalBytes * 100)) : 0;
  const remaining = Math.max(0, disk.totalBytes - disk.usedBytes);
  const pressured = percent >= warning;
  const forecast = disk.daysLeft === null ? "No growing trend" : disk.daysLeft <= 0 ? "Capacity reached" : `~${Math.max(1, Math.round(disk.daysLeft))} days`;
  return (
    <Card><CardContent className="space-y-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div><span className="text-2xl font-semibold tabular-nums tracking-tight">{bytes(disk.usedBytes)}</span><span className="ml-2 text-sm text-muted-foreground">in workspaces</span></div>
        <span className={cn("text-sm tabular-nums", pressured ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          {knownCapacity ? `${Math.round(percent)}% of ${bytes(disk.totalBytes)}` : "Capacity unavailable"}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Workspace share of disk capacity" aria-valuemin={0} aria-valuemax={100} aria-valuenow={knownCapacity ? Math.round(percent) : undefined}>
        <div className={cn("h-full rounded-full", pressured ? "bg-amber-500" : "bg-foreground/70")} style={{ width: `${percent}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
        <div><dt className="text-xs text-muted-foreground">Outside workspaces</dt><dd className="mt-1 text-sm font-medium tabular-nums">{knownCapacity ? bytes(remaining) : "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Daily change</dt><dd className="mt-1 text-sm font-medium tabular-nums">{disk.growthPerDay > 0 ? "+" : disk.growthPerDay < 0 ? "−" : ""}{bytes(Math.abs(disk.growthPerDay))}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Capacity forecast</dt><dd className={cn("mt-1 text-sm font-medium tabular-nums", disk.daysLeft !== null && disk.daysLeft <= 14 && "text-amber-600 dark:text-amber-400")}>{forecast}</dd></div>
      </dl>
      <p className="text-xs leading-relaxed text-muted-foreground">Workspace usage only; other files also occupy disk space. Warning at {warning}%.</p>
    </CardContent></Card>
  );
}
