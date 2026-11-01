import { Database, ArrowRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { EmptyState, Section, StatusDot } from "./primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  blockKey, canApprove, candidateLabel, formProblems, mergeBlocks, normalizeForm, prefill,
  refreshProvisionForm, requestState, selectCandidate, stateLabel, targetBlocks,
  type DbDiscovery, type DbRequestBlock, type DbRequestRow, type ProvisionForm,
} from "../dbRequestsView";

const CONTROL = "min-h-11 w-full min-w-0 rounded-md border bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const BLOCK_LABEL = { configuration: "Configuration", connection: "Connection", permission: "Permission", decision: "Decision" };

function Blocks({ blocks }: { blocks: DbRequestBlock[] }) {
  if (!blocks.length) return null;
  return <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3" role="status">
    <p className="mb-2 text-sm font-medium">Setup blocks</p>
    <ul className="grid gap-3 text-sm">
      {blocks.map((b) => <li key={blockKey(b)} className="min-w-0 break-words">
        <span className="font-medium">{BLOCK_LABEL[b.category] ?? "Setup"}: </span>{b.message}
        {b.action && <p className="mt-1 text-muted-foreground">{b.action}</p>}
      </li>)}
    </ul>
  </div>;
}

function RequestCard({ row, expanded, onExpand, onUpdate, onRefresh }: {
  row: DbRequestRow; expanded: boolean; onExpand: () => void;
  onUpdate: (row: DbRequestRow) => void; onRefresh: () => Promise<void>;
}) {
  const [form, setForm] = useState<ProvisionForm>(() => prefill(row));
  const [discovery, setDiscovery] = useState<DbDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const discoveryVersion = useRef(0);
  const edited = useRef(false);
  const state = requestState(row);
  const executing = ["executing", "verifying", "preparing"].includes(state);
  const finished = ["ready", "rejected"].includes(state);
  const immutable = executing || finished || !!row.operationId;
  const selectedCandidate = discovery?.candidates.find((c) => form.candidateId ? c.id === form.candidateId :
    c.server === form.server.trim() && c.container === form.container.trim());
  const blocks = targetBlocks(mergeBlocks(row.blocks, !row.plan ? discovery?.blocks : undefined), !row.plan ? selectedCandidate : undefined);
  const problems = formProblems(form);

  const discover = useCallback(async () => {
    const version = ++discoveryVersion.current;
    setDiscovering(true);
    try {
      const result = await api.dbRequestDiscovery(row.id);
      if (version !== discoveryVersion.current) return;
      setDiscovery(result);
      const matches = result.candidates.filter((c) => c.matched && c.verified);
      if (matches.length === 1 && !edited.current) {
        setForm((f) => selectCandidate(f, matches[0]));
      }
    } catch (e) {
      if (version === discoveryVersion.current) setError(`Target discovery failed: ${(e as Error).message}`);
    } finally {
      if (version === discoveryVersion.current) setDiscovering(false);
    }
  }, [row.id]);

  useEffect(() => {
    if (expanded && !row.plan && !finished) void discover();
    return () => { discoveryVersion.current += 1; };
  }, [expanded, row.id, discover]);

  // A reload restores the host's immutable plan; polling never overwrites edits.
  useEffect(() => {
    setForm((current) => refreshProvisionForm(current, row, edited.current));
  }, [row.plan, row.requested_scope, row.operationId]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (e) { setError((e as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function prepare() {
    await run(async () => {
      const normalized = normalizeForm(form);
      setForm(normalized);
      const next = await api.prepareDbRequest(row.id, normalized);
      edited.current = false;
      setDirty(false);
      if (next.plan) setForm(prefill(next));
      onUpdate(next);
    });
  }

  function change(patch: Partial<ProvisionForm>) {
    edited.current = true;
    setDirty(true);
    setForm((f) => ({ ...f, ...patch }));
  }

  const statusKind = state === "ready" ? "ok" : state === "failed" ? "danger" : state === "rejected" ? "idle" : "waiting";
  const planVisible = !!row.plan && !dirty;

  return <Card className="mb-3 scroll-mt-6 shadow-none" id={`db-request-${row.id}`}>
    <CardContent className="py-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400"><Database className="size-5" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="break-words font-medium">{row.wanted} <span className="text-xs font-normal text-muted-foreground">Request #{row.id}</span></p>
          <p className="mt-1 break-words text-sm text-muted-foreground">{row.project ?? row.session_id ?? "Unknown session"}</p>
          <p className="mt-2 inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1 text-xs" aria-live="polite"><StatusDot kind={statusKind} />{stateLabel(row)}{row.operationId ? ` · Operation #${row.operationId}` : ""}</p>
        </div>
        <Button className="min-h-11" variant="outline" aria-expanded={expanded} aria-controls={`db-request-detail-${row.id}`} onClick={onExpand}>
          {expanded ? <X className="size-4" aria-hidden="true" /> : <ArrowRight className="size-4" aria-hidden="true" />}{expanded ? "Close details" : finished ? "View result" : "Review setup"}
        </Button>
      </div>
      {!expanded && row.blocks?.length ? <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">{row.blocks.length} setup {row.blocks.length === 1 ? "block" : "blocks"} · {row.blocks[0].message}</p> : null}
      {expanded && <div className="mt-4 grid gap-4 border-t pt-4" id={`db-request-detail-${row.id}`}>
        <p className="break-words text-sm"><span className="text-muted-foreground">Purpose: </span>{row.why || "No purpose supplied."}</p>
        {error && <p role="alert" className="break-words rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
        <Blocks blocks={blocks} />
        {row.nextAction && <p className="break-words text-sm text-muted-foreground">{row.nextAction}</p>}
        {row.step && <p role="status" className="break-words text-sm font-medium">{row.step}</p>}
        {row.note && <p className="break-words text-sm">{row.note}</p>}

        {!finished && <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (!busy && !immutable && !problems.length) void prepare(); }}>
          <fieldset disabled={busy || immutable} className="grid min-w-0 gap-4 disabled:opacity-70">
            {!row.plan && <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">Production target</span>
                <Button className="min-h-11" type="button" variant="ghost" disabled={discovering} onClick={() => { setError(null); void discover(); }}>
                  {discovering ? "Finding databases…" : "Refresh targets"}
                </Button>
              </div>
              {discovery?.candidates.length ? <label className="grid min-w-0 gap-2 text-sm">
                <span>{discovery.candidates.length === 1 ? "Matched database" : "Choose the database and environment"}</span>
                <select className={CONTROL} value={form.candidateId ?? ""} onChange={(e) => {
                  const picked = discovery.candidates.find((c) => c.id === e.target.value);
                  if (picked) change(selectCandidate(form, picked));
                  else change({ candidateId: undefined, server: "", container: "" });
                }}>
                  <option value="">Select a target</option>
                  {discovery.candidates.map((c) => <option key={c.id} value={c.id} disabled={!c.verified}>{candidateLabel(c)}{!c.verified ? " · unverified" : ""}</option>)}
                </select>
              </label> : !discovering && <p className="text-sm text-muted-foreground">No matching target found. Refresh after fixing the blocks above, or specify a catalog server in advanced settings.</p>}
            </div>}

            <label className="flex min-h-11 items-start gap-3 rounded-md border p-3 text-sm">
              <input className="mt-0.5 size-4 shrink-0" type="checkbox" checked={form.write} onChange={(e) => change({ write: e.target.checked, ...(!e.target.checked ? { migrations: false } : {}) })} />
              <span><span className="font-medium">Enable production write proposals</span><span className="mt-1 block text-muted-foreground">Read-only access stays read-only. Each SQL statement or migration requires its own approval.</span></span>
            </label>

            {form.write && <label className="flex min-h-11 items-start gap-3 rounded-md border p-3 text-sm">
              <input className="mt-0.5 size-4 shrink-0" type="checkbox" checked={!!form.migrations} onChange={(e) => change({ migrations: e.target.checked })} />
              <span><span className="font-medium">Enable schema migration proposals</span><span className="mt-1 block text-muted-foreground">Prepare a host-only role with the database ownership rights needed for DDL. Each exact migration still requires separate approval.</span></span>
            </label>}

            <details className="rounded-md border px-3">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Advanced settings</summary>
              <div className="grid gap-3 pb-4 sm:grid-cols-2">
                {selectedCandidate?.application && <p className="break-words text-sm text-muted-foreground sm:col-span-2">Application: {selectedCandidate.applicationName ? `${selectedCandidate.applicationName} · ` : ""}UUID {selectedCandidate.application}</p>}
                {([["server", "Catalog server"], ["container", "Database container"], ["db", "Database name"],
                  ["roUser", "Read-only role"], ["opItem", "1Password read-only item"], ["opVault", "1Password vault (optional)"],
                  ...(form.write ? [["rwUser", "Write role"], ["rwOpItem", "1Password write item"]] as const : [])] as const).map(([key, label]) =>
                  <label key={key} className="grid min-w-0 gap-1.5 text-sm"><span>{label}</span>
                    <input className={CONTROL} autoComplete="off" spellCheck={false} data-1p-ignore="" value={String(form[key] ?? "")}
                      onChange={(e) => change({ [key]: e.target.value, ...(["server", "container", "db", "engine"].includes(key) ? { candidateId: undefined } : {}) })}
                      onBlur={() => setForm((f) => normalizeForm(f))} />
                  </label>)}
                <label className="grid min-w-0 gap-1.5 text-sm"><span>Database engine</span>
                  <select className={CONTROL} value={form.engine} onChange={(e) => change({ engine: e.target.value, candidateId: undefined })}>
                    <option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option>
                  </select>
                </label>
                <label className="grid min-w-0 gap-1.5 text-sm"><span>Local port (Auto checks availability)</span>
                  <input className={CONTROL} type="number" min={1024} max={65535} placeholder="Auto" value={form.hostPort || ""}
                    onChange={(e) => change({ hostPort: e.target.value ? Number(e.target.value) : 0 })} />
                </label>
              </div>
            </details>
          </fieldset>

          {(dirty || !row.plan) && problems.length > 0 && !discovering && <ul className="grid gap-1 text-sm text-muted-foreground" aria-label="Fields needed for preparation">
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>}

          {planVisible && row.plan && <div className="grid gap-3 rounded-md border bg-muted/30 p-4" aria-label="Prepared onboarding plan">
            <p className="text-sm font-medium">Prepared changes</p>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Server</dt><dd className="break-words font-medium">{row.plan.entry.server}</dd></div>
              <div><dt className="text-muted-foreground">Database</dt><dd className="break-words font-medium">{row.plan.entry.db} · {row.plan.entry.engine}</dd></div>
              <div className="sm:col-span-2"><dt className="text-muted-foreground">Access scope</dt><dd>{row.plan.migrations ? "Read-only access, individually approved writes, and a host-only role for individually approved schema migrations." : row.plan.write ? "Read-only access and a separate role for individually approved writes." : "Read-only access."}</dd></div>
            </dl>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              {row.plan.changes.map((step, i) => <li key={i} className="break-words">{step}</li>)}
            </ol>
            <p className="text-sm text-muted-foreground">The host executes and verifies this plan after approval. Database passwords and private keys stay on the host. This approval does not authorize a production migration.</p>
          </div>}

          {dirty && row.plan && <p className="text-sm text-amber-700 dark:text-amber-400">Settings changed. Prepare the updated plan before approving.</p>}
          <div className="flex flex-wrap gap-2">
            {!immutable && (!row.plan || dirty || ["blocked", "failed", "verification_required"].includes(state)) && <Button className="min-h-11" type="submit" disabled={busy || discovering || problems.length > 0}>
              {busy ? "Checking setup…" : row.plan || state === "blocked" ? "Check and prepare again" : "Prepare onboarding"}
            </Button>}
            {planVisible && canApprove(row, dirty) && <Button className="min-h-11" type="button" disabled={busy} onClick={() => void run(async () => {
              await api.approveOperation(row.operationId!);
              onUpdate(await api.dbRequest(row.id));
            })}>{busy ? "Starting setup…" : "Approve and set up"}</Button>}
            {row.operationId && ["failed", "blocked"].includes(state) && <Button className="min-h-11" type="button" disabled={busy} onClick={() => void run(async () => {
              await api.resumeDbRequest(row.id);
              onUpdate(await api.dbRequest(row.id));
            })}>{busy ? "Resuming setup…" : "Resume approved setup"}</Button>}
            {!executing && !finished && !(["failed", "blocked"].includes(state) && row.operationId) && <Button className="min-h-11" type="button" variant="outline" disabled={busy} onClick={() => void run(async () => { await api.rejectDbRequest(row.id); await onRefresh(); })}>Reject request</Button>}
          </div>
        </form>}
        {executing && <p role="status" className="text-sm">The host is completing the approved operation. This view updates automatically; approval alone does not mean access is ready.</p>}
        {state === "ready" && <p className="text-sm text-emerald-700 dark:text-emerald-400">Access was verified and the catalog updated. The agent can continue in the current session. Any migration still requires its own approval.</p>}
        {finished && row.plan && <p className="text-sm text-muted-foreground">Target: {row.plan.entry.server} / {row.plan.entry.db}</p>}
      </div>}
    </CardContent>
  </Card>;
}

/** Approval uses the existing Operations executor. Only host verification marks access ready. */
export function DbRequests() {
  const [rows, setRows] = useState<DbRequestRow[] | null>(null);
  const [open, setOpen] = useState<number | null>(() => Number(location.hash.match(/[?&]request=(\d+)(?:&|$)/)?.[1]) || null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const next = await api.dbRequests();
      if (version !== loadVersion.current) return;
      setRows(next); setLoadError(null);
    } catch (e) { if (version === loadVersion.current) setLoadError((e as Error).message); }
  }, []);
  useEffect(() => {
    void load(); const timer = setInterval(() => void load(), 5000);
    const followHash = () => setOpen(Number(location.hash.match(/[?&]request=(\d+)(?:&|$)/)?.[1]) || null);
    window.addEventListener("hashchange", followHash);
    return () => { clearInterval(timer); loadVersion.current += 1; window.removeEventListener("hashchange", followHash); };
  }, [load]);

  function update(row: DbRequestRow) {
    // Ignore an older list response that started before this action completed.
    loadVersion.current += 1;
    setRows((current) => (current ?? []).map((r) => r.id === row.id ? row : r));
  }

  return <Section label="Database access requests">
    {loadError && <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">Unable to refresh requests: {loadError}. Existing results remain visible.</p>}
    {rows === null ? <p className="text-sm text-muted-foreground" role="status">Loading database requests…</p> : rows.length === 0
      ? <EmptyState title="No requests" hint="Agents ask here when they need a database that is not in the catalog." />
      : rows.map((row) => <RequestCard key={row.id} row={row} expanded={open === row.id} onExpand={() => setOpen(open === row.id ? null : row.id)} onUpdate={update} onRefresh={load} />)}
  </Section>;
}
