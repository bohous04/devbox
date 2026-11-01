import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { api, type UnpushedBranch, type UnpushedFolder, type UnpushedRepo, type UnpushedReport } from "../api";
import { ActionButton, AppPage, Chevron, Collapse, EmptyState, RowsSkeleton, Section, StatusDot } from "../components/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { agoLabel } from "../format";
import { useNow } from "../store";
import {
  branchKey, branchLabel, canCreatePr, canPush, commitsLabel, folderKey, prBody, prTitle, repoFlags, repoKey, repoTitle, shortHash, toggled,
} from "../unpushedView";

/** What just succeeded — after a push/PR the branch disappears from the report (it is no longer unpushed),
 *  so the confirmation and the PR link have to live outside it, above the list. */
interface Notice { text: string; url?: string }

/** Expansion is shared by all three levels (folder → repo → branch): the page holds one
 *  set of expanded keys and each block reads its own from it. */
interface Expand { expanded: ReadonlySet<string>; onToggle: (key: string) => void }

/** Header of an expandable row: arrow + content, the whole thing is a button. Each level
 *  supplies its own sizing and indentation. */
function Toggle({ open, onToggle, className, children }: { open: boolean; onToggle: () => void; className?: string; children: ReactNode }) {
  return (
    <button type="button" className={cn("flex items-center gap-2 rounded-md text-left hover:bg-accent/50", className)} onClick={onToggle} aria-expanded={open}>
      <Chevron open={open} />
      {children}
    </button>
  );
}

/** One branch: the header (branch → upstream, count) toggles the commit list, the
 *  Push / Create PR actions next to it stay visible even for a collapsed branch — they are siblings,
 *  not button content (a button inside a button is not valid HTML). The hash is monospace and
 *  short — the full one does not belong here, the user searches by it in the terminal, not copies it. */
function BranchBlock({ repo, b, now, onDone, expanded, onToggle }: { repo: UnpushedRepo; b: UnpushedBranch; now: number; onDone: (n: Notice) => Promise<void> } & Expand) {
  const [prOpen, setPrOpen] = useState(false);
  const [title, setTitle] = useState(() => prTitle(b));
  const [err, setErr] = useState<string | null>(null);
  const key = branchKey(repo.path, b.branch);
  const open = expanded.has(key);

  async function push() {
    setErr(null);
    await api.unpushedPush(repo.path, b.branch);
    await onDone({ text: `Pushed ${b.branch} to origin (${repoTitle(repo)}).` });
  }

  async function createPr() {
    setErr(null);
    const t = title.trim();
    if (!t) { setErr("Title is required."); return; }
    const r = await api.unpushedPr(repo.path, b.branch, t, prBody(b));
    setPrOpen(false);
    await onDone({ text: `Pull request${r.number ? ` #${r.number}` : ""} created for ${b.branch} (${repoTitle(repo)}).`, url: r.url });
  }

  return (
    <div className="flex flex-col gap-1.5 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <Toggle open={open} onToggle={() => onToggle(key)} className="-mx-1.5 min-w-0 flex-1 px-1.5 py-1">
          <span className="truncate font-mono text-xs font-semibold">{branchLabel(b)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{commitsLabel(b.count, b.truncated ? b.commits.length : undefined)}</span>
        </Toggle>
        {canPush(repo) && (
          <ActionButton size="sm" variant="outline" onAction={push} onError={setErr}>Push</ActionButton>
        )}
        {canCreatePr(repo) && (
          <Button size="sm" variant={prOpen ? "secondary" : "outline"} onClick={() => { setPrOpen((o) => !o); setErr(null); }}>
            Create PR
          </Button>
        )}
      </div>
      <Collapse open={prOpen}>
        {/* Push + PR in one click: the server first pushes the branch (both gh and Gitea require it
            on the remote), then opens a PR against the remote's default branch. The PR body is
            built from the commits (see prBody) — the title is the only thing worth editing. */}
        <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
          <div className="text-xs text-muted-foreground">
            {b.branch} → {repo.base ?? "main"} on {repo.remote?.provider === "github" ? "GitHub" : "Gitea"} · {repo.remote?.owner}/{repo.remote?.name}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-8 min-w-[240px] flex-1" value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createPr(); }} placeholder="Pull request title" aria-label="Pull request title" />
            <ActionButton size="sm" onAction={createPr} onError={setErr}>Push + create PR</ActionButton>
            <Button size="sm" variant="ghost" onClick={() => setPrOpen(false)}>Cancel</Button>
          </div>
          <div className="text-xs text-muted-foreground">Body: {commitsLabel(b.count)} listed as bullet points.</div>
        </div>
      </Collapse>
      {err && <div className="text-xs font-medium text-destructive">{err}</div>}
      <Collapse open={open}>
        {/* Indent = arrow (size-3.5) + gap (gap-2), so the hash lines up under the branch name. */}
        <ul className="space-y-1 pl-5.5">
          {b.commits.map((c) => (
            <li key={c.hash} className="flex items-baseline gap-2.5 text-sm">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{shortHash(c.hash)}</span>
              <span className="min-w-0 flex-1 truncate" title={c.subject}>{c.subject}</span>
              <span className="shrink-0 text-xs text-muted-foreground" title={c.author}>{c.at > 0 ? agoLabel(now - c.at) : ""}</span>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

/** Repo (= one session): the whole header is a toggle, branches below it. A git error is
 *  shown even for a collapsed repo — it is the reason the count may not add up. */
function RepoBlock({ r, now, onDone, expanded, onToggle }: { r: UnpushedRepo; now: number; onDone: (n: Notice) => Promise<void> } & Expand) {
  const key = repoKey(r.path);
  const open = expanded.has(key);
  return (
    <div className="flex flex-col gap-3 border-t pt-3.5 first:border-t-0 first:pt-0">
      <Toggle open={open} onToggle={() => onToggle(key)} className="-mx-2 flex-wrap px-2 py-1.5">
        <StatusDot kind={r.error ? "danger" : "waiting"} />
        <span className="font-mono text-sm font-semibold">{repoTitle(r)}</span>
        {repoFlags(r).map((f) => (
          <Badge key={f} variant="outline" className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">{f}</Badge>
        ))}
        <span className="text-xs text-muted-foreground">{commitsLabel(r.count)}</span>
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground" title={r.path}>{r.path}</span>
      </Toggle>
      {r.error && <div className="text-xs font-medium text-destructive">git failed here: {r.error}</div>}
      {r.branches.length > 0 && (
        <Collapse open={open}>
          <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
            {r.branches.map((b) => <BranchBlock key={b.branch} repo={r} b={b} now={now} onDone={onDone} expanded={expanded} onToggle={onToggle} />)}
          </div>
        </Collapse>
      )}
    </div>
  );
}

function FolderCard({ f, now, onDone, expanded, onToggle }: { f: UnpushedFolder; now: number; onDone: (n: Notice) => Promise<void> } & Expand) {
  const failed = f.repos.filter((r) => r.error).length;
  const key = folderKey(f.folder);
  const open = expanded.has(key);
  return (
    <Card className="overflow-hidden">
      <Toggle open={open} onToggle={() => onToggle(key)} className="h-14 w-full rounded-none px-3.5">
        <span className="truncate font-mono text-sm font-semibold">{f.folder}/</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {f.repos.length} {f.repos.length === 1 ? "repo" : "repos"}
          {failed > 0 && ` · ${failed} failed`}
        </span>
        <span className="ml-auto shrink-0 font-mono text-sm font-semibold tabular-nums">{commitsLabel(f.count)}</span>
      </Toggle>
      <Collapse open={open}>
        <CardContent className="flex flex-col gap-3.5 border-t p-4">
          {f.repos.map((r) => <RepoBlock key={r.path} r={r} now={now} onDone={onDone} expanded={expanded} onToggle={onToggle} />)}
        </CardContent>
      </Collapse>
    </Card>
  );
}

/* ============================== page ============================== */

export function Unpushed() {
  const [report, setReport] = useState<UnpushedReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The default state is "everything collapsed" — folders, repos and branches. The page serves as
  // an overview of what is pending where; the user expands commits only when interested.
  // The set is forgotten after leaving the page (no localStorage).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const now = useNow(30_000);

  async function load(fresh = false) {
    try {
      setReport(await api.unpushed(fresh));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  // The first load uses the cache (the page opens immediately), Refresh forces a new scan.
  useEffect(() => { load(); }, []);

  const toggle = (key: string) => setExpanded((s) => toggled(s, key));

  // After a push/PR the server cache is dropped, so a plain load already brings a new scan.
  async function done(n: Notice) {
    setNotice(n);
    await load();
  }

  return (
    <AppPage
      title="Work in progress"
      sub="Commits that exist only on this machine — by folder, newest first. Uncommitted changes are not counted."
      actions={
        <ActionButton size="sm" variant="outline" onAction={() => load(true)} onError={setErr}>Rescan</ActionButton>
      }
    >
      {err && <div className="mb-4 text-sm font-medium text-destructive">Failed to load: {err}</div>}

      <AnimatePresence>
        {notice && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
            <StatusDot kind="ok" />
            <span>{notice.text}</span>
            {notice.url && (
              <a href={notice.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline">
                Open <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            )}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setNotice(null)}>Dismiss</Button>
          </motion.div>
        )}
      </AnimatePresence>

      <Section
        label="Unpushed commits"
        meta={report && (
          <span className="text-xs text-muted-foreground">
            <span className="font-mono text-sm font-semibold text-foreground tabular-nums">{report.total}</span>
            {" "}across {report.folders.length} {report.folders.length === 1 ? "folder" : "folders"} · {report.scanned} repos scanned · {agoLabel(now - report.at)}
          </span>
        )}
      >
        {!report ? <RowsSkeleton rows={3} /> : report.folders.length === 0 ? (
          <EmptyState title="Everything is pushed" hint={`All ${report.scanned} repositories have their commits on a remote.`} />
        ) : (
          <div className="flex flex-col gap-2">
            {report.folders.map((f) => (
              <FolderCard key={f.folder} f={f} now={now} onDone={done} expanded={expanded} onToggle={toggle} />
            ))}
          </div>
        )}
      </Section>
    </AppPage>
  );
}
