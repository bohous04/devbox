import { useEffect, useRef, useState } from "react";
import { api, type ProdWrite } from "../api";
import { AppPage, EmptyState, Section, StatusDot } from "../components/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { agoLabel } from "../format";
import { useNow, useStore } from "../store";

const STATUS: Record<ProdWrite["status"], { dot: string; label: string }> = {
  blocked: { dot: "waiting", label: "Access setup needed" },
  pending: { dot: "waiting", label: "Waiting for SQL approval" },
  approved: { dot: "waiting", label: "Approved · execution pending" },
  executed: { dot: "ok", label: "Executed" }, failed: { dot: "danger", label: "Failed" }, rejected: { dot: "idle", label: "Rejected" },
};
const BLOCKS: Record<string, string> = {
  database_unknown: "The database is not in the catalog yet.",
  write_access_not_configured: "A separate write role must be configured.",
  migration_access_not_configured: "A host migration role with the required ownership rights must be configured.",
  write_access_not_granted: "This project needs approval for write proposals.",
};

export function ProdWrites() {
  const { refresh } = useStore();
  const [rows, setRows] = useState<ProdWrite[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [preview, setPreview] = useState<Record<number, string>>({});
  const busyRef = useRef(false);
  const version = useRef(0);
  const now = useNow(10_000);

  async function load() {
    const current = ++version.current;
    try { const next = await api.prodWrites(); if (current === version.current) { setRows(next); setLoadError(null); } }
    catch (e) { if (current === version.current) setLoadError((e as Error).message); }
  }
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => { clearInterval(t); version.current += 1; }; }, []);

  async function act(id: number, fn: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(id); setActionError(null);
    try { await fn(); await load(); await refresh(); }
    catch (e) { setActionError(`Write #${id}: ${(e as Error).message}`); }
    finally { busyRef.current = false; setBusy(null); }
  }

  const active = (rows ?? []).filter((w) => ["blocked", "pending", "approved"].includes(w.status));
  const past = (rows ?? []).filter((w) => !["blocked", "pending", "approved"].includes(w.status));

  function writeCard(w: ProdWrite) {
    return <Card key={w.id} id={`prod-write-${w.id}`}>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot kind={STATUS[w.status]?.dot ?? "idle"} />
          <span className="break-words text-sm font-semibold">{w.db} · Write #{w.id}</span>
          <Badge variant="outline">{STATUS[w.status]?.label ?? w.status}</Badge>
          <span className="ml-auto text-xs text-muted-foreground">{agoLabel(now - w.ts)}</span>
        </div>
        <p className="mt-2 text-sm"><span className="text-muted-foreground">Scope: </span>{w.scope === "migration" ? "Schema migration (DDL) · host-only migration role" : "Data write (DML) · separate write role"}</p>
        <p className="mt-1 break-words text-xs text-muted-foreground">{w.session_id ?? "Unknown session"}</p>
        {w.status === "blocked" && <div className="mt-3">
          <Button className="min-h-11" variant="outline" disabled={busy !== null} onClick={() => void act(w.id, () => api.prodWriteReject(w.id))}>{busy === w.id ? "Working…" : "Reject SQL proposal"}</Button>
        </div>}
        {w.status === "pending" && <>
          <p className="mt-3 text-sm text-muted-foreground">Approval runs only this exact SQL with the displayed scope. Database access approval does not approve this statement.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button className="min-h-11" variant="outline" disabled={busy !== null} onClick={() => void act(w.id, async () => {
              const note = (await api.prodWritePreview(w.id)).note; setPreview((s) => ({ ...s, [w.id]: note }));
            })}>Review statement</Button>
            <Button className="min-h-11" disabled={busy !== null || !!w.code} onClick={() => void act(w.id, () => api.prodWriteApprove(w.id))}>{busy === w.id ? "Working…" : "Approve and execute SQL"}</Button>
            <Button className="min-h-11" variant="outline" disabled={busy !== null} onClick={() => void act(w.id, () => api.prodWriteReject(w.id))}>Reject</Button>
          </div>
        </>}
        {preview[w.id] && <p className="mt-2 rounded-md border bg-muted/40 p-3 text-sm">{preview[w.id]}</p>}
        {(w.result || w.error) && <p className={`mt-2 break-words text-sm ${w.error ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}>{w.error ?? w.result}</p>}
        {w.exception && <p className="mt-2 rounded-md border border-amber-500/40 p-3 text-sm"><span className="font-medium">Recorded explicit exception: </span>{w.exception}</p>}
        {w.code && <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">{w.access?.state === "rejected" ? "Database access was rejected."
            : w.access?.blocks?.length ? "Database access is blocked." : BLOCKS[w.code] ?? w.code}</p>
          {w.access?.engine && <p className="mt-1 text-muted-foreground">Database engine: {w.access.engine}</p>}
          {w.access?.state !== "rejected" && w.access?.blocks?.map((block, index) => <div key={`${block.code}-${index}`} className="mt-2">
            <p>{block.message}</p>
            <p className="mt-1 text-muted-foreground">{block.action}</p>
          </div>)}
          {w.nextAction && <p className="mt-1 text-muted-foreground">{w.nextAction}</p>}
          {w.requestId && <a className="mt-1 inline-flex min-h-11 items-center underline" href={`#/operations?request=${w.requestId}`}>Review database request #{w.requestId}</a>}
        </div>}
        <pre className="mt-3 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs" aria-label={`Exact SQL for write ${w.id}`}>{w.sql}</pre>
      </CardContent>
    </Card>;
  }

  return <AppPage title="Prod writes" sub="Review the exact production SQL, target and scope. Every statement has its own approval.">
    {(loadError || actionError) && <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">{actionError ?? loadError}</p>}
    <Section label="Active SQL proposals" meta={rows ? `${active.length}` : "loading…"}>
      {rows && active.length === 0 && <EmptyState title="No active writes" hint="Database writes and schema migrations proposed by an agent appear here." />}
      <div className="space-y-3">{active.map(writeCard)}</div>
    </Section>
    {past.length > 0 && <Section label="History" meta={`${past.length}`}><div className="space-y-3">{past.map(writeCard)}</div></Section>}
  </AppPage>;
}
