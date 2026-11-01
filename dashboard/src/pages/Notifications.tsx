import { useEffect, useState } from "react";
import { api, type NotifyDecision, type NotifyLogRow, type NotifyVerdict } from "../api";
import { ActionButton, AppPage, EmptyState, Section } from "../components/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { agoLabel } from "../format";
import { useNow } from "../store";
import { sessionShort } from "../eventLabels";
import { groupByTurn, promptExcerpt } from "../notificationsView";

const DECISION_TONE: Record<NotifyDecision, string> = {
  sent: "text-emerald-600 dark:text-emerald-400",
  armed: "text-sky-600 dark:text-sky-400",
  deferred: "text-amber-600 dark:text-amber-400",
  suppressed: "text-muted-foreground",
  none: "text-muted-foreground",
};

// English UI (dashboard convention since 2026-07-26); wire values stay snake_case.
const EVENT_LABEL: Record<string, string> = {
  stop: "Stop", sweep_done: "Notification sent", user_prompt_submit: "Prompt",
  subagent_start: "Subagent started", subagent_stop: "Subagent finished",
  teammate_idle: "Teammate idle", task_created: "Task created", task_completed: "Task completed",
  permission_request: "Permission request", notification: "Notification",
};

const VERDICT_LABEL: Record<NotifyVerdict, string> = {
  false_positive: "Fired but shouldn't have",
  missing: "Should have fired",
  ok: "Correct",
};

type Filter = "all" | "sent" | "flagged";

export function Notifications() {
  const [rows, setRows] = useState<NotifyLogRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // A note being typed for a row, until it is sent together with the verdict.
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(10_000);

  async function load(f: Filter = filter) {
    try {
      // "Only sent" filters on the server (decision=sent), not over the last 300 rows
      // of all decisions — on the live devbox sent/sweep_done is rare compared to subagent_start
      // /stop noise and a client-side filter could show nothing even when sent exists.
      setRows(await api.notifyLog({
        limit: 300,
        verdict: f === "flagged" ? "flagged" : undefined,
        decision: f === "sent" ? "sent" : undefined,
      }));
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { load(filter); }, [filter]);

  async function mark(row: NotifyLogRow, verdict: NotifyVerdict | null) {
    try {
      await api.setNotifyVerdict(row.id, verdict, verdict ? notes[row.id]?.trim() || undefined : undefined);
      setNotes((n) => {
        if (!(row.id in n)) return n;
        const next = { ...n }; delete next[row.id]; return next;
      });
      await load(filter);
    } catch (e) { setErr((e as Error).message); }
  }

  const shown = rows ?? [];
  const groups = groupByTurn(shown);

  return (
    <AppPage title="Notifications" sub="Why every done notification was sent — or held back.">
      <Section label="Decisions" meta={rows ? `${shown.length}` : "loading…"}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(["all", "sent", "flagged"] as Filter[]).map((f) => (
            <Button key={f} variant={filter === f ? "default" : "outline"} size="sm" onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "sent" ? "Only sent" : "Only flagged"}
            </Button>
          ))}
          <ActionButton variant="outline" size="sm" onAction={() => load(filter)}>Refresh</ActionButton>
          {err && <span className="text-xs font-medium text-destructive">Error: {err}</span>}
        </div>

        {rows && shown.length === 0 && (
          <EmptyState title="Nothing logged yet" hint="Decisions show up here as soon as an agent runs." />
        )}

        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span className="min-w-0 flex-1 truncate normal-case">
                  {g.header ? (promptExcerpt(g.header) ?? "(prompt not recorded)") : "No prompt in view"}
                </span>
                {g.header && <span className="shrink-0 text-muted-foreground/70">{agoLabel(now - g.header.ts)}</span>}
              </div>
              <div className="space-y-2">
                {[...g.rows, ...(g.header ? [g.header] : [])].map((r) => (
                  <Card key={r.id} className={cn(r.verdict && "border-amber-500/60")}>
                    <CardContent className="flex flex-wrap items-start gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className={cn("font-medium", DECISION_TONE[r.decision])}>{r.decision}</Badge>
                          <span className="text-sm">{EVENT_LABEL[r.event] ?? r.event}</span>
                          <span className="text-xs text-muted-foreground">{sessionShort(r.session_id)}</span>
                          {r.reason && <span className="text-xs text-muted-foreground">· {r.reason}</span>}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          subagents in flight: {r.inflight} · teammate tasks: {r.teammates}
                          {r.detail && ` · ${r.detail}`}
                        </div>
                        {r.verdict ? (
                          <div className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                            {VERDICT_LABEL[r.verdict]}{r.verdict_note && ` — ${r.verdict_note}`}
                          </div>
                        ) : (
                          <Input
                            value={notes[r.id] ?? ""}
                            onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                            placeholder="Optional note"
                            className="mt-2 h-7 max-w-xs text-xs"
                          />
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-xs text-muted-foreground" title={new Date(r.ts).toLocaleString("en-US")}>
                          {agoLabel(now - r.ts)}
                        </span>
                        <div className="flex gap-1">
                          {r.verdict ? (
                            <ActionButton variant="ghost" size="sm" onAction={() => mark(r, null)}>Clear flag</ActionButton>
                          ) : (
                            <>
                              {r.decision === "sent" && (
                                <ActionButton variant="outline" size="sm" onAction={() => mark(r, "false_positive")}>Wrong</ActionButton>
                              )}
                              {r.decision === "deferred" && (
                                <ActionButton variant="outline" size="sm" onAction={() => mark(r, "missing")}>Should have fired</ActionButton>
                              )}
                              <ActionButton variant="outline" size="sm" onAction={() => mark(r, "ok")}>Correct</ActionButton>
                            </>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </AppPage>
  );
}
