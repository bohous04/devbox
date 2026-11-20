import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon, Folder, RotateCw } from "lucide-react";
import { api, type SessionChanges, type SessionFileDiff } from "@/api";
import { cn } from "@/lib/utils";
import { CHANGES_OPEN_MAX, changesError, changesTitle, fileStat, groupByFolder, splitPath, statusLetter } from "../../changesView";
import { Collapse } from "../primitives";
import { FileDiff } from "./FileDiff";
import { limiter, OPEN_ALL_MAX } from "../../diffView";

const STATUS_COLOR = {
  added: "text-emerald-600 dark:text-emerald-400", untracked: "text-emerald-600 dark:text-emerald-400",
  modified: "text-amber-600 dark:text-amber-400", renamed: "text-sky-600 dark:text-sky-400",
  deleted: "text-red-600 dark:text-red-400",
} as const;

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex-none font-mono text-xs tabular-nums">
      {/* A zero side is dimmed so the real change reads first. */}
      <span className={added ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/60"}>+{added}</span>{" "}
      <span className={removed ? "text-red-600 dark:text-red-400" : "text-muted-foreground/60"}>−{removed}</span>
    </span>
  );
}

/** The session worktree's changes against devd's base, under the thread's latest answer. It is the worktree's
 *  state now, not this turn's diff, and says so ("vs origin/main"). `refreshKey` refetches it (the latest run's
 *  end). Loading and a clean worktree show nothing; a failed load says so with a retry. */
export function ChangesCard({ sessionId, refreshKey, onLayout }: {
  sessionId: string; refreshKey: number | null;
  /** Called after the card appeared or changed height (its data or error arrived), so the page can keep its end in view. */
  onLayout?: () => void;
}) {
  const [changes, setChanges] = useState<SessionChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null until the user toggles: then a short list starts open.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Files whose diff is shown, by path.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(() => {
    let alive = true;
    setError(null);
    api.sessionChanges(sessionId).then(
      (c) => { if (alive) { setChanges(c); setShown(new Set()); } },
      (e) => { if (alive) { setChanges(null); setError(changesError(e)); } },
    );
    return () => { alive = false; };
  }, [sessionId]);
  useEffect(() => load(), [load, refreshKey]);
  useEffect(() => { onLayout?.(); }, [changes, error, onLayout]);

  // One cache per /changes result: a new result (the run ended, a retry) drops every diff fetched before it.
  // A failed fetch is not kept, so Retry asks again. At most 4 requests run at once.
  const fetchDiff = useMemo(() => {
    const run = limiter(4);
    const cache = new Map<string, Promise<SessionFileDiff>>();
    return (path: string) => {
      let p = cache.get(path);
      if (!p) {
        p = run(() => api.sessionFileDiff(sessionId, path));
        cache.set(path, p);
        p.catch(() => cache.delete(path));
      }
      return p;
    };
  }, [sessionId, changes]);

  if (error !== null) {
    return (
      <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <span title={error}>Couldn't load changes</span>
        <button type="button" onClick={() => load()} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground">
          <RotateCw className="size-3" aria-hidden="true" />Retry
        </button>
      </p>
    );
  }
  if (changes === null || changes.totals.files === 0) return null;
  const open = userOpen ?? changes.files.length <= CHANGES_OPEN_MAX;
  const groups = groupByFolder(changes.files);
  const allShown = changes.files.every((f) => shown.has(f.path));
  const toggleFile = (path: string) => setShown((s) => {
    const next = new Set(s);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  return (
    <section aria-label="Changed files" className="mt-3 overflow-hidden rounded-lg border border-border/80 bg-card/30 text-sm">
      {/* A disclosure in the thread, not a link away: the chevron points down and turns when open. */}
      <div className="flex min-w-0 items-center">
      <button type="button" aria-expanded={open} onClick={() => setUserOpen(!open)} title={`Changes vs ${changes.base}`}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 py-2 pl-3 pr-2 text-left transition-colors hover:bg-muted/40">
        <FileDiffIcon className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
        <span className="flex-none font-medium text-foreground">{changesTitle(changes)}</span>
        <Stat added={changes.totals.added} removed={changes.totals.removed} />
        {/* A phone has no room for the base: it is in the header's title there. */}
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">vs {changes.base}</span>
        <ChevronDown className={cn("ml-auto size-4 flex-none text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {changes.files.length <= OPEN_ALL_MAX && <button type="button" onClick={() => { setUserOpen(true); setShown(allShown ? new Set() : new Set(changes.files.map((f) => f.path))); }}
        className="mr-1.5 flex-none rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
        {allShown ? "Hide diffs" : "Open diffs"}
      </button>}
      </div>
      <Collapse open={open}>
        <ul className="border-t border-border/60 py-1.5 font-mono text-xs">
          {groups.map((g) => (
            <li key={g.dir}>
              {g.dir && (
                <div className="flex min-w-0 items-center gap-2 px-3 py-0.5 text-muted-foreground" title={g.dir}>
                  <Folder className="size-3.5 flex-none opacity-70" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{g.dir}</span>
                  {/* One folder's sum would only repeat the header's totals. */}
                  {groups.length > 1 && g.files.length > 1 && <Stat added={g.added} removed={g.removed} />}
                </div>
              )}
              <ul>
                {g.files.map((f) => {
                  const stat = fileStat(f);
                  const full = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
                  return (
                    <li key={`${f.status}:${f.path}`}>
                      <button type="button" title={full} aria-expanded={shown.has(f.path)} onClick={() => toggleFile(f.path)}
                        className={cn("group flex w-full min-w-0 items-center gap-2 py-1 pr-3 text-left transition-colors hover:bg-muted/50 aria-expanded:bg-muted/30", g.dir ? "pl-8" : "pl-3")}>
                        <span className={cn("w-3 flex-none text-center font-semibold", STATUS_COLOR[f.status])} title={f.status} aria-label={f.status}>{statusLetter(f.status)}</span>
                        <span className="min-w-0 flex-1 truncate text-foreground/90 group-hover:text-foreground">
                          {f.oldPath && <span className="text-muted-foreground">{splitPath(f.oldPath).name} → </span>}
                          {splitPath(f.path).name}
                        </span>
                        {stat === "binary" ? <span className="flex-none text-muted-foreground">binary</span> : <Stat {...stat} />}
                        <ChevronRight className="size-3.5 flex-none text-muted-foreground transition-transform group-aria-expanded:rotate-90" aria-hidden="true" />
                      </button>
                      <Collapse open={shown.has(f.path)}>
                        <FileDiff path={f.path} fetchDiff={fetchDiff} onLayout={onLayout} />
                      </Collapse>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {changes.truncated && (
            <li className="px-3 pt-1 font-sans text-xs text-muted-foreground">
              {changes.files.length} of {changes.totals.files} files listed
            </li>
          )}
        </ul>
      </Collapse>
    </section>
  );
}
