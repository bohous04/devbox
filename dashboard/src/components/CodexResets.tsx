import { useEffect, useState } from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import { safeSourceUrl, type CodexResetSnapshot } from "../../../shared/codexResets";
import { useNow } from "../store";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";

const dateLabel = (value: string) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
export function CodexResets() {
  const [snapshot, setSnapshot] = useState<CodexResetSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const now = useNow(60_000);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/codex-resets", { signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const data = await response.json() as CodexResetSnapshot;
        if (!controller.signal.aborted) { setSnapshot(data); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
    }
    void load();
    const timer = setInterval(load, 5 * 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [retry]);
  const status = snapshot?.status;
  const latest = status?.data.latest_reset;
  const scheduled = status?.data.scheduled_reset;
  const watch = status?.data.active_watch;
  const activeWatch = watch && Date.parse(watch.expires_at) > now ? watch : null;
  const source = safeSourceUrl((scheduled ?? latest)?.source.url);
  const unavailable = error || snapshot?.stale;
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2"><RefreshCw className="size-4 text-muted-foreground" /><h2 className="text-sm font-medium">Codex resets</h2>
            {unavailable && <Badge variant="outline">{status ? "Saved data · update unavailable" : "Unavailable"}</Badge>}
          </div>
          <a href="https://codex-resets.com" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">Data from Codex Resets <ExternalLink className="size-3" /></a>
        </div>
        {!snapshot && !error ? <p className="mt-2 text-sm text-muted-foreground" role="status">Loading reset announcements…</p> : !status ? <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Reset information is temporarily unavailable.</p><Button variant="outline" size="sm" onClick={() => setRetry((v) => v + 1)}>Retry</Button></div> : (
          <div className="mt-3 grid gap-5 sm:grid-cols-2">
            <div><p className="text-xs text-muted-foreground">Last {latest?.reset_type === "banked" ? "banked credit" : "reset"}</p><p className="mt-1 text-sm font-medium">{latest ? dateLabel(latest.announced_at) : "No reset recorded"}</p><p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{latest?.text}</p></div>
            <div><p className="text-xs text-muted-foreground">{scheduled ? "Announced reset" : "Next reset"}</p><p className="mt-1 text-sm font-medium">{scheduled ? (scheduled.scheduled_for ? dateLabel(scheduled.scheduled_for) : "Date not announced") : "No confirmed date"}</p>
              {scheduled ? <p className="mt-1 text-xs text-muted-foreground">Awaiting confirmation that it happened.{scheduled.scheduled_for && Date.parse(scheduled.scheduled_for) <= now ? " The announced time has passed." : ""}</p> : activeWatch ? <p className="mt-1 text-xs text-muted-foreground">Unofficial AI forecast{activeWatch.reset_chance_percent === null ? "" : ` · ${activeWatch.reset_chance_percent}%`}: {activeWatch.forecast_window}</p> : <p className="mt-1 text-xs text-muted-foreground">Public announcements, independent of your account limits.</p>}
              {source && <a href={source} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs underline underline-offset-4">View announcement <ExternalLink className="size-3" /></a>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
