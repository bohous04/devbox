import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentUpkeepStatus, UpkeepProvider } from "../../../shared/agentUpkeep";
import { agentUpkeepApi } from "../agentUpkeepApi";
import { AppPage, ActionButton, EmptyState } from "../components/primitives";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ArrowUpCircle, Box, CheckCircle2, ChevronRight, CircleHelp, Clock3, Download, FolderGit2, RefreshCw, Search, ShieldCheck, Sparkles, Terminal, Zap, X } from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
const providers = [
  { id: "claude", short: "CC", label: "Claude Code", icon: Sparkles, color: "text-orange-600 dark:text-orange-400", selected: "border-orange-400/50 bg-orange-500/10", tile: "bg-orange-500/15" },
  { id: "codex", short: "CO", label: "Codex", icon: Terminal, color: "text-emerald-600 dark:text-emerald-400", selected: "border-emerald-400/50 bg-emerald-500/10", tile: "bg-emerald-500/15" },
  { id: "grok", short: "GR", label: "Grok Build", icon: Zap, color: "text-violet-600 dark:text-violet-400", selected: "border-violet-400/50 bg-violet-500/10", tile: "bg-violet-500/15" },
  { id: "agy", short: "AG", label: "Antigravity", icon: Sparkles, color: "text-sky-600 dark:text-sky-400", selected: "border-sky-400/50 bg-sky-500/10", tile: "bg-sky-500/15" },
] as const;
const older = (a:string,b:string) => { const x=a.split(".").map(Number),y=b.split(".").map(Number); for(let i=0;i<3;i++){if(x[i]<y[i])return true;if(x[i]>y[i])return false;} return false; };

export function AgentUpkeep() {
  const [provider,setProvider] = useState<UpkeepProvider>("claude");
  const [status,setStatus] = useState<AgentUpkeepStatus|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [result,setResult] = useState<string|null>(null);
  const [search, setSearch] = useState("");
  const [repo, setRepo] = useState("");
  const request = useRef(0);
  const active = useRef(false);
  async function load() {
    const id=++request.current;setError(null);
    try { const data=await agentUpkeepApi.status(provider);if(id===request.current)setStatus(data); }
    catch(e){if(id===request.current)setError((e as Error).message);}
  }
  useEffect(()=>{setStatus(null);setResult(null);void load();return()=>{request.current++;};},[provider]);
  async function run(session?:string) {
    if(active.current)return;active.current=true;setBusy(true);setError(null);setResult(null);
    try {
      const r=await agentUpkeepApi.run(provider,session);
      const parts=[r.error,r.built ? "Image updated" : null,r.updated.length ? `Installed in ${r.updated.length} session(s)` : null,r.restarted.length ? `Restarted ${r.restarted.length} session(s)` : null,r.deferred.length ? `Deferred: ${r.deferred.join(", ")} (active work or update cooldown)` : null,r.failed.length ? `Failed: ${r.failed.join(", ")}` : null,r.unchanged.length ? `${r.unchanged.length} already current` : null].filter(Boolean);
      setResult(parts.join(" · ")||"No changes confirmed. Review the refreshed versions and session history.");
      await load();
    } catch(e){setError((e as Error).message);} finally {active.current=false;setBusy(false);}
  }
  const selected = providers.find(p => p.id === provider)!;
  const sessions = status?.sessions ?? [];
  const stateOf = (s: typeof sessions[number]) => {
    if (s.version !== null && status?.latest && older(s.version, status.latest)) return "update";
    if (s.restartRequired) return "reopen";
    if (s.version === null || !status?.latest || s.restartRequired === null || s.running === null) return "unknown";
    return "current";
  };
  const states = {
    current: { label: "Current", icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10" },
    // agy: the binary is root-owned and changes only with an image build (see Task 3), so upkeep
    // cannot install anything here — "Update available" would promise a button that is
    // missing; instead it shows what the user has to do.
    update: { label: provider === "agy" ? "Newer version available — rebuild the devbox image" : "Update available", icon: ArrowUpCircle, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10" },
    reopen: { label: "Reopen when finished", icon: Clock3, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10" },
    unknown: { label: "Unknown", icon: CircleHelp, color: "text-muted-foreground", bg: "bg-muted" },
  } as const;
  const repositories = [...new Set(sessions.map(s => `${s.project}/${s.repo}`))].sort();
  const filtered = sessions.filter(s => (!repo || `${s.project}/${s.repo}` === repo) && `${s.project}/${s.repo} ${s.id} ${s.version ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <AppPage title="Agent upkeep" sub="Keep every agent ready for your next session." actions={<ActionButton variant="outline" className="min-h-11" disabled={busy} icon={<RefreshCw className="size-4" />} onAction={load}>Refresh versions</ActionButton>}>
    <div className="mb-5 grid grid-cols-3 gap-2 sm:gap-3" role="group" aria-label="Agent runtime">
      {providers.map(p => <button key={p.id} type="button" aria-pressed={provider === p.id} disabled={busy} onClick={() => { setProvider(p.id); setRepo(""); }} className={`flex min-h-20 items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:p-4 ${provider === p.id ? p.selected : "border-border bg-card hover:bg-muted/50"}`}>
        <span className={`hidden size-10 shrink-0 items-center justify-center rounded-xl sm:flex ${p.tile} ${p.color}`}><p.icon className="size-5" /></span>
        <span className="min-w-0"><span className={`block text-xs font-semibold tracking-wider ${p.color}`}>{p.short}</span><span className="mt-0.5 block text-sm font-medium sm:text-base">{p.label}</span></span>
        {provider === p.id && <span className={`ml-auto hidden size-2 shrink-0 rounded-full bg-current sm:block ${p.color}`} />}
      </button>)}
    </div>
    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      <Card className="shadow-none"><CardContent className="p-5"><div className="flex items-center justify-between text-xs font-medium text-muted-foreground"><span>Latest stable</span><Download className="size-4" /></div><div className="mt-3 font-mono text-2xl font-semibold tracking-tight tabular-nums">{status ? status.latest ?? "Unknown" : "—"}</div><p className="mt-1 text-xs text-muted-foreground">{selected.label} release</p></CardContent></Card>
      <Card className="shadow-none"><CardContent className="p-5"><div className="flex items-center justify-between text-xs font-medium text-muted-foreground"><span>Base image</span><Box className="size-4" /></div><div className="mt-3 font-mono text-2xl font-semibold tracking-tight tabular-nums">{status ? status.image ?? "Unknown" : "—"}</div><p className="mt-1 text-xs text-muted-foreground">Version in new containers</p></CardContent></Card>
      <Card className="shadow-none"><CardContent className="p-5"><div className="flex items-center justify-between text-xs font-medium text-muted-foreground"><span>Running sessions</span><Terminal className="size-4" /></div><div className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{status ? sessions.length : "—"}</div><p className="mt-1 text-xs text-muted-foreground">{provider === "claude" ? "Nightly maintenance" : provider === "agy" ? "Updated with the devbox image" : "Automatic checks on launch"}</p></CardContent></Card>
    </div>
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-border/70 bg-muted/30 px-4 py-3">
      <ShieldCheck className={`mt-0.5 size-4 shrink-0 ${selected.color}`} /><p className="text-xs leading-relaxed text-muted-foreground">{provider === "claude" ? "Claude Code uses the existing nightly updater and guarded conversation restarts." : provider === "agy" ? "Antigravity runs from the devbox image. Rebuild the image to update it; this page shows which version each session runs." : "Updates are checked on launch, at most once per hour per container. Running conversations keep their current process. Reopen after finishing to use a newly installed version."}</p>
    </div>
    {error && <p className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p>}
    {result && <p className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm" role="status">{result}</p>}
    <Card className="overflow-hidden shadow-none"><CardContent className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5"><div><h2 className="text-base font-semibold">Session versions</h2><p className="mt-0.5 text-xs text-muted-foreground">{status ? `${sessions.length} sessions across ${repositories.length} repositories` : "Checking installed versions…"}</p></div>{/* agy: no "Update" — the binary changes only with an image build (see Task 3). */}{provider !== "agy" && <ActionButton className="min-h-11" disabled={busy || !sessions.length} icon={<Download className="size-4" />} onAction={() => run()}>Update all sessions</ActionButton>}</div>
      {status && sessions.length > 0 && <>
        <div className="flex flex-wrap gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">{(Object.keys(states) as (keyof typeof states)[]).map(key => { const style = states[key]; return <span key={key} className="inline-flex items-center gap-1.5 text-xs"><style.icon className={`size-3.5 ${style.color}`} /><span className="font-semibold tabular-nums">{sessions.filter(s => stateOf(s) === key).length}</span><span className="text-muted-foreground">{style.label}</span></span>; })}</div>
        <div className="flex flex-col gap-2 p-4 sm:flex-row sm:px-5"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" /><Input aria-label="Search sessions" placeholder="Search session or repository…" value={search} onChange={e => setSearch(e.target.value)} className="h-11 pl-9" /></div><select aria-label="Filter by repository" value={repo} onChange={e => setRepo(e.target.value)} className="h-11 min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-64"><option value="">All repositories</option>{repositories.map(r => <option key={r} value={r}>{r}</option>)}</select>{(search || repo) && <Button variant="ghost" className="h-11" onClick={() => { setSearch(""); setRepo(""); }}><X className="size-4" aria-hidden="true" />Clear</Button>}</div>
      </>}
      {!status ? <EmptyState title={error ? "Versions unavailable" : "Loading versions…"} /> : !sessions.length ? <EmptyState title="No running sessions" hint="Installed versions appear when a session is running." /> : !filtered.length ? <EmptyState title="No matching sessions" hint="Try a different search or clear the repository filter." /> : <div className="divide-y border-t">{filtered.map(s => { const style = states[stateOf(s)]; return <div key={s.id} className="flex flex-col gap-3 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:gap-5">
        <div className="flex min-w-0 flex-1 items-center gap-3"><span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${selected.tile} ${selected.color}`}><FolderGit2 className="size-5" /></span><div className="min-w-0"><Link to={`/sessions?open=${encodeURIComponent(s.id)}`} className="group inline-flex max-w-full items-center gap-1 text-sm font-semibold hover:underline"><span className="truncate">{s.repo}</span><ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /></Link><p className="truncate text-xs text-muted-foreground" title={`${s.project} · ${s.id}`}>{s.project} · {s.id}</p></div></div>
        <div className="flex flex-wrap items-center gap-3 pl-13 lg:gap-5 lg:pl-0"><div className="min-w-24"><p className="font-mono text-sm tabular-nums">{s.version ?? "Unknown"}</p><p className="text-xs text-muted-foreground">{s.running === null ? "Processes unknown" : `${s.running} running ${s.running === 1 ? "process" : "processes"}`}</p></div><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium lg:min-w-36 ${style.bg} ${style.color}`}><style.icon className="size-3.5 shrink-0" />{style.label}</span>{provider !== "agy" && <ActionButton variant="outline" className="ml-auto min-h-11" disabled={busy} aria-label={`Update ${s.project}/${s.repo} session ${s.id}`} icon={<Download className="size-3.5" />} onAction={() => run(s.id)}>Update</ActionButton>}</div>
      </div>; })}</div>}
    </CardContent></Card>
  </AppPage>;
}
