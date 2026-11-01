import { Check, X, Rocket, Clock3, CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { AppPage, EmptyState, Section, StatusDot } from "../components/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { agoLabel } from "../format";
import { useNow } from "../store";
import { operationReview, operationStatus, pendingFirst, type OpRow } from "../operationsView";
import { DbRequests } from "../components/DbRequests";

const DOT_KIND: Record<string, string> = {
  pending: "waiting", approved: "waiting", running: "working", executed: "ok", failed: "danger", rejected: "idle",
};

export function Operations() {
  const [rows, setRows] = useState<OpRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<number | null>(null);
  const now = useNow(10_000);

  async function load() {
    try { setRows(await api.operations()); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  async function act(id: number, fn: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(id); setActionError(null);
    try { await fn(); await load(); } catch (e) { setActionError((e as Error).message); } finally { busyRef.current = false; setBusy(null); }
  }

  const sorted = pendingFirst(rows ?? []);
  return (
    <AppPage title="Operations" sub="Review access and deployments.">
      {(actionError || err) && <p role="alert" className="text-sm text-red-600">{actionError ?? err}</p>}
      <div className="mb-7 grid gap-3 sm:grid-cols-3">{[
        {label:"Awaiting approval",count:sorted.filter(r=>r.status==="pending").length,icon:Clock3,tone:"text-amber-600 bg-amber-500/10"},
        {label:"In progress",count:sorted.filter(r=>["approved","running"].includes(r.status)).length,icon:Rocket,tone:"text-blue-600 bg-blue-500/10"},
        {label:"Completed",count:sorted.filter(r=>r.status==="executed").length,icon:CheckCircle2,tone:"text-emerald-600 bg-emerald-500/10"}
      ].map(c=><div key={c.label} className="flex items-center gap-3 rounded-xl border p-4"><span className={`flex size-10 items-center justify-center rounded-xl ${c.tone}`}><c.icon className="size-5" aria-hidden="true" /></span><div><div className="text-2xl font-semibold tabular-nums">{rows ? c.count : "—"}</div><div className="text-xs text-muted-foreground">{c.label}</div></div></div>)}</div>
      <DbRequests />
      <Section label="Deployments & operations">
        {sorted.length === 0
          ? <EmptyState title="Nothing proposed" hint="Agents can propose operations from a session." />
          : sorted.map((r) => { const review = operationReview(r);
            let params: Record<string, unknown> = {};
            try { const parsed = JSON.parse(r.params); if (parsed && typeof parsed === "object") params = parsed; } catch {}
            const title = typeof params.app === "string" ? params.app : r.op;
            const fields = Object.entries(params).filter(([k])=> !["app","changes","fingerprint","idempotencyKey","afterWrite"].includes(k));
            const tone = r.status === "pending" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : r.status === "executed" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : r.status === "failed" ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-blue-500/10 text-blue-700 dark:text-blue-400";
            return (
            <Card key={r.id} className="mb-3 overflow-hidden shadow-none">
              <CardContent className="space-y-4 p-5">
                <div className="flex flex-wrap items-start gap-3">
                  <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone}`}><Rocket className="size-5" aria-hidden="true" /></span>
                  <div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{title}</h3><p className="mt-1 text-xs text-muted-foreground"><span className="capitalize">{r.op}</span> · #{r.id} · {agoLabel(now-r.ts)}</p></div>
                  <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}><StatusDot kind={DOT_KIND[r.status] ?? "idle"} />{operationStatus(r)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">{fields.map(([k,v])=><span key={k} className="max-w-full break-words rounded-md border bg-muted/30 px-2 py-1 text-xs"><span className="mr-1.5 capitalize text-muted-foreground">{k}</span>{typeof v === "string" ? v : JSON.stringify(v)}</span>)}<span className="text-xs text-muted-foreground">{r.session_id ?? "Unknown session"}</span></div>
                {r.result && <span className="text-xs text-emerald-600 dark:text-emerald-400">{r.result}</span>}
                {r.error && <span className="text-xs text-red-600">{r.error}</span>}
                {review.changes.length > 0 && <ol className="list-decimal space-y-2 rounded-lg bg-muted/40 py-3 pl-8 pr-3 text-sm" aria-label="Prepared operation changes">{review.changes.map((change, i) => <li className="break-words" key={i}>{change}</li>)}</ol>}
                {review.afterWrite && <p className="w-full text-sm text-muted-foreground">This deployment can start only after SQL proposal #{review.afterWrite} succeeds. Access approval alone cannot release it.</p>}
                {review.problem && <p className="w-full text-sm text-red-600">{review.problem}</p>}
                {r.op === "db-onboard" && review.requestId && (
                  <a className="ml-auto inline-flex min-h-11 items-center text-sm underline" href={`#/operations?request=${review.requestId}`}>Review database request #{review.requestId}</a>
                )}
                {r.status === "pending" && r.op !== "db-onboard" && (
                  <span className="flex flex-wrap justify-end gap-2 border-t pt-3">
                    <Button className="min-h-11" size="sm" disabled={busy !== null || !!review.problem} onClick={() => act(r.id, () => api.approveOperation(r.id))}>
                      <Check className="size-4" aria-hidden="true" />Approve operation
                    </Button>
                    <Button className="min-h-11" size="sm" variant="outline" disabled={busy !== null} onClick={() => act(r.id, () => api.rejectOperation(r.id))}>
                      <X className="size-4" aria-hidden="true" />Reject
                    </Button>
                  </span>
                )}
              </CardContent>
            </Card>
          ); })}
      </Section>
    </AppPage>
  );
}
