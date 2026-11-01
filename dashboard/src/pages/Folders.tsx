import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Folder, FolderOpen, FolderPlus, GitBranch, Layers, Plus, Download, Trash2, RefreshCw, Check, Loader2, Search, X } from "lucide-react";
import { createAutoSave } from "../autoSave";
import { FormDialog } from "../components/FormDialog";
import {
  api, type CloneJob, type CloneScope, type GiteaInstanceInfo, type GiteaRepo,
  type GithubOwner, type GithubRepo, type TreeProject,
} from "../api";
import { RepoBrowser } from "../components/RepoBrowser";
import {
  ActionButton, AppPage, ConfirmButton, EmptyState, RowsSkeleton, Section, StatusDot,
} from "../components/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { pctOf } from "../format";
import {
  addFolder, addProject, addRepo, addSource, cloneConfig, configIssues, findSource, hasUpstreamRepo, removeUpstreamRepo, uniqueRepoName,
  mergeFolders, removeFolder, removeProject, removeRepo, removeSource, sourceKey, sourceLabel,
  targetLabel, validateConfig,
  type DevConfig, type FolderCfg, type ProjectCfg, type Target, type Visibility,
} from "../configEdit";

/** Names are edited in a focused modal; confirmed changes save automatically. */
function AddRow({ placeholder, cta, onAdd, disabled = false }: { placeholder: string; cta: string; onAdd: (name: string) => string | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return <>
    <Button variant="outline" disabled={disabled} onClick={() => { setName(""); setErr(null); setOpen(true); }}><FolderPlus className="size-4" />{cta}</Button>
    <FormDialog open={open} onOpenChange={setOpen} title={cta} description="Changes are saved automatically.">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; const error = onAdd(name.trim()); setErr(error); if (!error) setOpen(false); }}>
        <label className="grid gap-1.5 text-sm font-medium">Name<Input required placeholder={placeholder} value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} /></label>
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={!name.trim()}><Plus className="size-4" />{cta}</Button></div>
      </form>
    </FormDialog>
  </>;
}

interface Actions {
  openBrowser: (t: Target) => void;
  removeRepo: (t: Target, name: string) => void;
  removeSource: (t: Target, key: string) => void;
  addProject: (folder: string, name: string) => string | null;
  removeProject: (folder: string, name: string) => void;
  removeFolder: (name: string) => void;
}

/** Explicit repos and source-discovered repos share one readable list. Only
 * explicit assignments can be removed individually; sources remain editable. */
function CfgBlock({ title, sub, target, cfg, actions, cloned, discovered = [], extra }: {
  title: string; sub?: string; target: Target; cfg: ProjectCfg; actions: Actions;
  cloned: Set<string>; discovered?: TreeProject["repos"]; extra?: ReactNode;
}) {
  const sources = cfg.sources ?? [];
  const explicit = cfg.repos ?? [];
  const names = new Set(explicit.map((r) => r.name));
  const repos = [...explicit.map((r) => ({ ...r, direct: true })), ...(sources.length ? discovered : []).filter((r) => !names.has(r.name)).map((r) => ({ ...r, direct: false }))].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/25 px-4 py-3">
        <Layers className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{title}</h3><p className="mt-0.5 text-xs text-muted-foreground">{sub} · {repos.length} {repos.length === 1 ? "repository" : "repositories"}</p></div>
        <Button variant="outline" size="sm" onClick={() => actions.openBrowser(target)}><Plus className="size-4" />Add repositories</Button>
        {extra}
      </div>
      {sources.length > 0 && <div className="space-y-2 border-b bg-muted/10 p-3">
        {sources.map((source) => <div key={sourceKey(source)} className="flex items-center gap-3 rounded-md border border-dashed px-3 py-2">
          <Layers className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{sourceLabel(source)}</p><p className="text-xs text-muted-foreground">Automatically includes repositories from this owner</p></div>
          <Button size="icon" variant="ghost" className="size-11 shrink-0" aria-label={`Remove source ${sourceLabel(source)}`} onClick={() => actions.removeSource(target, sourceKey(source))}><X className="size-4" /></Button>
        </div>)}
      </div>}
      {repos.length === 0 ? <div className="px-4 py-6 text-sm text-muted-foreground">{sources.length ? "Repositories will appear after the source is saved and loaded." : "No repositories yet. Browse GitHub or Gitea to add your first one."}</div> : <div className="divide-y">
        {repos.map((repo) => <div key={repo.name} className="flex min-h-16 items-center gap-3 px-4 py-2">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium" title={repo.cloneUrl ?? ("repo" in repo ? repo.repo : undefined) ?? repo.name}>{repo.name}</p><p className="truncate text-xs text-muted-foreground">{repo.provider}{!repo.direct ? " · via source" : ""}</p></div>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><StatusDot kind={cloned.has(repo.name) ? "ok" : "off"} />{cloned.has(repo.name) ? "On disk" : "Not cloned"}</span>
          {repo.direct ? <Button size="icon" variant="ghost" className="size-11 shrink-0" aria-label={`Remove repo ${repo.name}`} onClick={() => actions.removeRepo(target, repo.name)}><X className="size-4" /></Button> : <span className="w-11 shrink-0" />}
        </div>)}
      </div>}
    </div>
  );
}

function countRepos(fc: FolderCfg): { repos: number; sources: number } {
  let repos = fc.repos?.length ?? 0;
  let sources = fc.sources?.length ?? 0;
  for (const p of Object.values(fc.projects ?? {})) {
    repos += p.repos?.length ?? 0;
    sources += p.sources?.length ?? 0;
  }
  return { repos, sources };
}

function FolderCard({ name, fc, tree, open, onToggle, actions, onClone, busy }: {
  name: string; fc: FolderCfg; tree: TreeProject[]; open: boolean; onToggle: () => void;
  actions: Actions; onClone: () => Promise<void>; busy: boolean;
}) {
  const projects = Object.keys(fc.projects ?? {}).sort();
  const { repos: configRepos, sources } = countRepos(fc);

  // Which repo is already on disk — per project, so the status shows on the right chip.
  const clonedByProject = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of tree.filter((t) => t.folder === name)) {
      m.set(p.project, new Set(p.repos.filter((r) => r.cloned).map((r) => r.name)));
    }
    return m;
  }, [tree, name]);

  // The denominator MUST come from the tree, not the config: `sources` means "all
  // repos of that owner", so a folder with three sources has two explicit repos in the config,
  // but there are 37 on disk (otherwise the nonsense "37/2 cloned" comes out).
  const treeRows = tree.filter((t) => t.folder === name);
  const total = treeRows.length > 0
    ? treeRows.reduce((a, p) => a + p.repos.length, 0)
    : configRepos;
  const clonedCount = treeRows.reduce((a, p) => a + p.repos.filter((r) => r.cloned).length, 0);

  return (
    <Card className={cn("overflow-hidden", open && "border-foreground/20")}>
      <div className="flex min-h-20 items-center gap-2 px-3 py-2">
        <button className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-md px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onToggle} aria-expanded={open}>
          <ChevronRight className={cn("size-3.5 flex-none text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">{open ? <FolderOpen className="size-5" /> : <Folder className="size-5" />}</span>
          <span className="min-w-0"><span className="block truncate text-sm font-semibold">{name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{projects.length > 0 ? `${projects.length} projects · ` : ""}{clonedCount} of {total} on disk{sources > 0 ? ` · ${sources} sources` : ""}</span></span>
        </button>
        <ActionButton variant="outline" size="sm" disabled={busy} onAction={onClone} icon={<Download className="size-4" />}>Clone</ActionButton>
      </div>

        {open && (
          <div>
            <CardContent className="flex flex-col gap-4 border-t bg-muted/15 p-3 sm:p-4">
              {(fc.repos?.length || fc.sources?.length || projects.length === 0) ? (
                <CfgBlock title="Folder repositories" sub="Stored directly in this folder" target={{ folder: name }} cfg={fc}
                  actions={actions} cloned={clonedByProject.get(name) ?? new Set()} discovered={treeRows.find((r) => r.project === name)?.repos} />
              ) : <Button variant="ghost" className="self-start text-muted-foreground" onClick={() => actions.openBrowser({ folder: name })}><Plus className="size-4" />Add repositories directly to folder</Button>}

              {projects.map((p) => (
                <CfgBlock key={p} title={p} sub="Project" target={{ folder: name, project: p }}
                  cfg={fc.projects?.[p] ?? {}} actions={actions} cloned={clonedByProject.get(p) ?? new Set()} discovered={treeRows.find((r) => r.project === p)?.repos}
                  extra={
                    <ConfirmButton size="sm" variant="ghost" confirmLabel="Delete it?"
                      onConfirm={() => actions.removeProject(name, p)}><Trash2 className="size-4" /><span className="sr-only sm:not-sr-only">Delete project</span></ConfirmButton>
                  } />
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <AddRow placeholder="project name" cta="Add project" onAdd={(n) => actions.addProject(name, n)} />
                <ConfirmButton size="sm" variant="ghost" confirmLabel={`Delete ${name}?`}
                  onConfirm={() => actions.removeFolder(name)}><Trash2 className="size-4" />Delete folder</ConfirmButton>
              </div>
            </CardContent>
          </div>
        )}
    </Card>
  );
}

/* ============================== page ============================== */

export function Folders() {
  const [draft, setDraft] = useState<DevConfig | null>(null);
  const [baseline, setBaseline] = useState("");
  const [tree, setTree] = useState<TreeProject[]>([]);
  const [giteaInfo, setGiteaInfo] = useState<GiteaInstanceInfo[]>([]);
  const [browserTarget, setBrowserTarget] = useState<Target | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [job, setJob] = useState<CloneJob | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    setLoadErr(null);
    try {
      const cfg = validateConfig(await api.config());
      setDraft(cloneConfig(cfg));
      setBaseline(JSON.stringify(cfg.folders));
      api.tree().then(setTree).catch(() => {});
      api.giteaInstances().then((r) => setGiteaInfo(r.instances)).catch(() => setGiteaInfo([]));
    } catch (e) { setLoadErr((e as Error).message); }
  }
  useEffect(() => { load(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  const dirty = useMemo(() => draft !== null && JSON.stringify(draft.folders) !== baseline, [draft, baseline]);
  const issues = useMemo(() => (draft ? configIssues(draft) : []), [draft]);

  const saver = useMemo(() => createAutoSave<DevConfig>(async (next) => {
    setSaving(true); setSaveErr(null);
    // Keep current server settings; this page owns only folders.
    const server = validateConfig(await api.config());
    const merged = validateConfig(mergeFolders(server, next));
    await api.saveConfig(merged);
    setBaseline(JSON.stringify(next.folders));
    setSaving(false);
    void api.tree().then(setTree).catch(() => {});
  }, (error) => { setSaving(false); setSaveErr(error instanceof Error ? error.message : String(error)); }), []);

  function mutate(next: DevConfig) {
    setDraft(next);
    if (configIssues(next).length === 0) { setSaving(true); setSaveErr(null); saver.enqueue(next); }
  }
  function tryMutate(fn: () => DevConfig): string | null {
    try { mutate(fn()); return null; } catch (e) { return (e as Error).message; }
  }

  const actions: Actions = {
    openBrowser: (t) => setBrowserTarget(t),
    removeRepo: (t, name) => { if (draft) tryMutate(() => removeRepo(draft, t, name)); },
    removeSource: (t, key) => { if (draft) tryMutate(() => removeSource(draft, t, key)); },
    addProject: (folder, name) => (draft ? tryMutate(() => addProject(draft, folder, name)) : "configuration not loaded"),
    removeProject: (folder, name) => { if (draft) tryMutate(() => removeProject(draft, folder, name)); },
    removeFolder: (name) => { if (draft) tryMutate(() => removeFolder(draft, name)); },
  };

  async function startClone(scope: CloneScope) {
    await saver.flush();
    const { jobId } = await api.clone(scope);
    setJob(await api.job(jobId));
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const j = await api.job(jobId);
        setJob(j);
        if (j.status !== "running") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          api.tree().then(setTree).catch(() => {});
        }
      } catch { /* the next tick retries */ }
    }, 1000);
  }

  const folderNames = draft ? Object.keys(draft.folders).sort() : [];
  const visibleFolders = folderNames.filter((name) => {
    const term = search.trim().toLowerCase();
    if (!term || name.toLowerCase().includes(term)) return true;
    return JSON.stringify(draft?.folders[name]).toLowerCase().includes(term) || tree.some((p) => p.folder === name && p.repos.some((r) => r.name.toLowerCase().includes(term)));
  });
  const cloning = job?.status === "running";
  const jobPct = job && job.total > 0 ? pctOf(job.done, job.total) : cloning ? 0 : 100;

  const browserValid = draft && browserTarget
    ? (browserTarget.project === undefined
      ? !!draft.folders[browserTarget.folder]
      : !!draft.folders[browserTarget.folder]?.projects?.[browserTarget.project])
    : false;

  return (
    <AppPage
      title="Folders"
      sub="Organize repositories into folders and projects, then clone them to your devbox."
      actions={<div className="flex flex-wrap gap-2"><ActionButton variant="outline" disabled={cloning} icon={<Download className="size-4" />} onAction={() => startClone({ scope: "all" })}>Clone all</ActionButton><AddRow placeholder="e.g. work" cta="Add folder" disabled={!draft} onAdd={(n) => { const error = draft ? tryMutate(() => addFolder(draft, n)) : "Configuration not loaded"; if (!error) { setOpenFolder(n); setSearch(""); } return error; }} /></div>}
    >
      {loadErr && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-destructive">
          <span>Failed to load configuration: {loadErr}</span>
          <Button variant="outline" size="sm" onClick={load}>Try again</Button>
        </div>
      )}

      <AnimatePresence>
        {job && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4">
            <Card><CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <StatusDot kind={cloning ? "working" : job.status === "done" ? "ok" : "danger"} pulse={cloning} />
                {cloning ? "Cloning…" : job.status === "done" ? "Done" : "Finished with errors"}
                <span className="ml-auto font-mono text-xs text-muted-foreground">{job.done}/{job.total}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <motion.div className={cn("h-full rounded-full", job.status === "error" ? "bg-destructive" : "bg-[var(--chart-1)]")}
                  initial={false} animate={{ width: `${jobPct}%` }} transition={{ duration: 0.4, ease: "easeOut" }} />
              </div>
              {job.results.length > 0 && (
                <div className="mt-3 max-h-[220px] space-y-1 overflow-y-auto border-t pt-3">
                  {job.results.map((r, i) => (
                    <div className="flex items-center gap-2 text-sm" key={`${r.repo}-${i}`}>
                      <span className={cn("font-semibold", r.ok ? (r.skipped ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400") : "text-destructive")}>
                        {r.ok ? (r.skipped ? "⤳" : "✓") : "✗"}
                      </span>
                      <span className="truncate">{r.repo}</span>
                      {r.skipped && <span className="text-xs text-muted-foreground">already there</span>}
                      {r.error && <span className="truncate text-xs text-destructive" title={r.error}>{r.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent></Card>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative mb-4"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" /><Input type="search" className="h-11 pl-9" placeholder="Find a folder, project or repository…" aria-label="Search folders" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <Section label="Your folders" meta={draft ? `${visibleFolders.length} folders` : "Loading…"}>
        {!draft ? <RowsSkeleton rows={4} /> : folderNames.length === 0 ? (
          <EmptyState title="No folders yet" hint="Create a folder, then add repositories from GitHub or Gitea." />
        ) : visibleFolders.length === 0 ? <EmptyState title="No matching folders" hint="Try a repository, project or folder name." /> : (
          <div className="flex flex-col gap-3">
            {visibleFolders.map((name) => (
              <FolderCard
                key={name}
                name={name}
                fc={draft.folders[name] ?? {}}
                tree={tree}
                open={openFolder === name}
                onToggle={() => setOpenFolder((o) => (o === name ? null : name))}
                actions={actions}
                busy={cloning}
                onClone={() => startClone({ scope: "folder", folder: name })}
              />
            ))}
          </div>
        )}

      </Section>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <span role="status" className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            {saving ? <><Loader2 className="size-4 animate-spin" />Saving…</> : saveErr ? "Changes not saved" : dirty ? "Changes need attention" : <><Check className="size-4 text-emerald-600" />All changes saved automatically</>}
          </span>
          {saveErr && <><span role="alert" className="text-xs text-destructive">{saveErr}</span><Button variant="outline" size="sm" onClick={() => { setSaving(true); setSaveErr(null); saver.retry(); }}><RefreshCw className="size-4" />Retry</Button></>}
          {issues.length > 0 && <span role="alert" className="text-xs text-destructive">{issues[0]}</span>}
        </CardContent>
      </Card>

      <AnimatePresence>
        {draft && browserTarget && browserValid && (
          <RepoBrowser
            key={targetLabel(browserTarget)}
            target={targetLabel(browserTarget)}
            github={{
              isRepoAdded: (fullName) => hasUpstreamRepo(draft, browserTarget, "github", fullName),
              ownerSource: (login) => findSource(draft, browserTarget, sourceKey({ provider: "github", user: login })),
              onToggleRepo: (r: GithubRepo) => tryMutate(() => hasUpstreamRepo(draft, browserTarget, "github", r.nameWithOwner)
                ? removeUpstreamRepo(draft, browserTarget, "github", r.nameWithOwner)
                : addRepo(draft, browserTarget, { name: uniqueRepoName(draft, browserTarget, r.name, r.nameWithOwner.split("/")[0] ?? ""), provider: "github", repo: r.nameWithOwner })),
              onAddSource: (o: GithubOwner, visibility: Visibility) => tryMutate(() => addSource(draft, browserTarget, {
                provider: "github",
                ...(o.kind === "org" ? { org: o.login } : { user: o.login }),
                ...(visibility !== "all" ? { visibility } : {}),
              })),
              onRemoveSource: (o: GithubOwner) =>
                tryMutate(() => removeSource(draft, browserTarget, sourceKey({ provider: "github", user: o.login }))),
            }}
            giteaInstances={giteaInfo}
            gitea={{
              isRepoAdded: (fullName, cloneUrl) => hasUpstreamRepo(draft, browserTarget, "gitea", fullName, cloneUrl),
              ownerSource: (instance, login) => findSource(draft, browserTarget, sourceKey({ provider: "gitea", user: login, instance })),
              onToggleRepo: (_instance: string, r: GiteaRepo) => tryMutate(() => hasUpstreamRepo(draft, browserTarget, "gitea", r.fullName, r.cloneUrl)
                ? removeUpstreamRepo(draft, browserTarget, "gitea", r.fullName, r.cloneUrl)
                : addRepo(draft, browserTarget, { name: uniqueRepoName(draft, browserTarget, r.name, r.owner), provider: "gitea", repo: r.fullName, cloneUrl: r.cloneUrl })),
              onAddSource: (instance: string, login: string) =>
                tryMutate(() => addSource(draft, browserTarget, { provider: "gitea", user: login, instance })),
              onRemoveSource: (instance: string, login: string) =>
                tryMutate(() => removeSource(draft, browserTarget, sourceKey({ provider: "gitea", user: login, instance }))),
            }}
            onClose={() => setBrowserTarget(null)}
          />
        )}
      </AnimatePresence>
    </AppPage>
  );
}
