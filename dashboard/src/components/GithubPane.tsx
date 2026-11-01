import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GithubOwner, type GithubRepo } from "../api";
import { agoLabel } from "../format";
import type { Source, Visibility } from "../configEdit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * GitHub tab of the RepoBrowser: account + orgs → repo list → a click adds/removes the
 * repo in the target (folder/project) of the config draft. The parent holds the draft; only
 * callbacks come here, so the content always shows the live state.
 */
export function GithubPane({ target, isRepoAdded, ownerSource, onToggleRepo, onAddSource, onRemoveSource }: {
  target: string;
  isRepoAdded: (fullName: string) => boolean;
  ownerSource: (login: string) => Source | undefined;
  onToggleRepo: (r: GithubRepo) => void;
  onAddSource: (o: GithubOwner, visibility: Visibility) => void;
  onRemoveSource: (o: GithubOwner) => void;
}) {
  const [owners, setOwners] = useState<GithubOwner[] | null>(null);
  const [ownersErr, setOwnersErr] = useState<string | null>(null);
  const [sel, setSel] = useState<GithubOwner | null>(null);
  const [repoCache, setRepoCache] = useState<Record<string, GithubRepo[]>>({});
  const [reposErr, setReposErr] = useState<string | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [q, setQ] = useState("");
  const [vis, setVis] = useState<Visibility>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    api.githubOwners()
      .then((r) => { if (alive) setOwners(r.owners); })
      .catch((e) => { if (alive) setOwnersErr((e as Error).message); });
    return () => { alive = false; };
  }, []);

  async function select(o: GithubOwner) {
    setSel(o);
    setQ("");
    setReposErr(null);
    if (repoCache[o.login]) return;
    setReposLoading(true);
    try {
      const { repos } = await api.githubRepos(o.login);
      setRepoCache((c) => ({ ...c, [o.login]: repos }));
      searchRef.current?.focus();
    } catch (e) {
      setReposErr((e as Error).message);
    } finally {
      setReposLoading(false);
    }
  }

  const repos = sel ? repoCache[sel.login] : undefined;
  const filtered = useMemo(() => {
    if (!repos) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((r) =>
      r.name.toLowerCase().includes(needle) ||
      r.nameWithOwner.toLowerCase().includes(needle) ||
      r.description.toLowerCase().includes(needle));
  }, [repos, q]);

  const src = sel ? ownerSource(sel.login) : undefined;
  const authHint = /auth|login|logged|credential|token/i.test(ownersErr ?? "");

  return (
    <>
      {ownersErr && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold text-destructive" role="alert">
          {authHint ? "GitHub account isn't logged in (gh auth login)" : "Failed to load GitHub"}
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            {authHint ? "Run \"gh auth login\" on the server and try again. · " : ""}{ownersErr}
          </span>
        </div>
      )}

      {!ownersErr && (
        <>
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Account and organizations</span>
          {owners === null ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2" aria-hidden="true">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[42px] rounded-lg" />)}
            </div>
          ) : owners.length === 0 ? (
            <p className="font-mono text-[11.5px] text-muted-foreground">gh didn't return any account.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
              {owners.map((o) => (
                <button
                  key={o.login}
                  className={cn(
                    "flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-border/80 hover:bg-accent",
                    sel?.login === o.login && "border-foreground/40 bg-accent",
                  )}
                  onClick={() => select(o)}
                >
                  {o.avatarUrl
                    ? <img className="size-6 flex-none rounded-full bg-muted" src={o.avatarUrl} alt="" loading="lazy" />
                    : <span className="flex size-6 flex-none items-center justify-center rounded-full border font-mono text-xs font-semibold text-muted-foreground">{o.login.charAt(0).toUpperCase()}</span>}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-semibold" title={o.name ?? o.login}>{o.login}</span>
                  <Badge variant="outline" className="flex-none font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">{o.kind === "user" ? "account" : "org"}</Badge>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {sel && !ownersErr && (
        <>
          {src ? (
            <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 dark:border-emerald-400/40">
              <span className="min-w-40 flex-1 font-mono text-xs font-medium text-emerald-700 dark:text-emerald-400">✓ The whole owner {sel.login} is a source — repos load automatically ({src.visibility === "private" ? "private only" : src.visibility === "public" ? "public only" : "all"})</span>
              <Button variant="ghost" size="sm" onClick={() => onRemoveSource(sel)}>Remove source</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-dashed p-3">
              <span className="min-w-40 flex-1 font-mono text-xs font-medium text-muted-foreground">Add the whole owner as a source:</span>
              <select
                className="h-8 rounded-md border bg-background px-2 font-mono text-xs text-foreground"
                value={vis}
                onChange={(e) => setVis(e.target.value as Visibility)}
                aria-label="Visibility"
              >
                <option value="all">all</option>
                <option value="private">private only</option>
                <option value="public">public only</option>
              </select>
              <Button variant="outline" size="sm" onClick={() => onAddSource(sel, vis)}>Add source</Button>
            </div>
          )}

          <div className="flex items-center gap-2.5">
            <Input
              ref={searchRef}
              className="h-8 flex-1"
              type="text"
              placeholder={`Search repos on ${sel.login}…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search repository"
            />
            {repos && <span className="flex-none font-mono text-xs tabular-nums text-muted-foreground">{filtered.length}/{repos.length}</span>}
          </div>

          {reposErr && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold text-destructive" role="alert">
              Failed to load repositories
              <span className="mt-1 block text-xs font-normal text-muted-foreground">{reposErr}</span>
            </div>
          )}
          {reposLoading && (
            <div className="flex flex-col gap-1.5" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9 rounded-md" />)}
            </div>
          )}
          {repos && !reposLoading && !reposErr && (
            filtered.length === 0 ? (
              <p className="font-mono text-[11.5px] text-muted-foreground">{repos.length === 0 ? "This owner has no repos." : "Nothing matches the search."}</p>
            ) : (
              <div className="flex flex-none flex-col overflow-hidden rounded-lg border">
                {filtered.map((r) => {
                  const added = isRepoAdded(r.nameWithOwner);
                  const ts = Date.parse(r.updatedAt);
                  return (
                    <button
                      key={r.nameWithOwner}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2.5 border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent",
                        added && "bg-foreground/5",
                        r.isArchived && "opacity-55",
                      )}
                      onClick={() => onToggleRepo(r)}
                      title={added ? `Remove ${r.nameWithOwner} from ${target}` : `Add ${r.nameWithOwner} to ${target}`}
                    >
                      <span
                        className={cn(
                          "flex size-[18px] flex-none items-center justify-center rounded-full border font-mono text-[11px] font-semibold text-muted-foreground",
                          added && "border-foreground bg-foreground text-background",
                        )}
                        aria-hidden="true"
                      >
                        {added ? "✓" : "+"}
                      </span>
                      <span className="max-w-[42%] flex-none truncate font-mono text-[12.5px] font-semibold">{r.name}</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "flex-none font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground",
                          r.isPrivate && "border-amber-600/40 bg-amber-600/10 text-amber-700 dark:border-amber-400/40 dark:text-amber-400",
                        )}
                      >
                        {r.isPrivate ? "private" : "public"}
                      </Badge>
                      {r.isArchived && <Badge variant="outline" className="flex-none border-destructive/40 font-mono text-[9.5px] uppercase tracking-wider text-destructive">archived</Badge>}
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground max-[640px]:hidden">{r.description}</span>
                      {Number.isFinite(ts) && <span className="flex-none font-mono text-[10.5px] text-muted-foreground max-[640px]:hidden">{agoLabel(Date.now() - ts)}</span>}
                    </button>
                  );
                })}
              </div>
            )
          )}
        </>
      )}

      {!sel && owners !== null && !ownersErr && owners.length > 0 && (
        <p className="font-mono text-[11.5px] text-muted-foreground">Select an account or organization — then just click repos.</p>
      )}
    </>
  );
}
