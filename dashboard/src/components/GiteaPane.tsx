import { useEffect, useMemo, useState } from "react";
import { api, type GiteaInstanceInfo, type GiteaRepo } from "../api";
import { agoLabel } from "../format";
import { deriveOwners, filterGiteaRepos } from "../giteaBrowse";
import type { Source } from "../configEdit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Gitea tab of the RepoBrowser: a single search across the whole instance (everything the token
 * sees — including other users' repos). Owners derived from the results serve as a
 * filter and as the target of "add owner as a source".
 */
export function GiteaPane({ target, instance, isRepoAdded, ownerSource, onToggleRepo, onAddSource, onRemoveSource }: {
  target: string;
  instance: GiteaInstanceInfo;
  isRepoAdded: (fullName: string, cloneUrl: string) => boolean;
  ownerSource: (login: string) => Source | undefined;
  onToggleRepo: (r: GiteaRepo) => void;
  onAddSource: (login: string) => void;
  onRemoveSource: (login: string) => void;
}) {
  const [repos, setRepos] = useState<GiteaRepo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRepos(null); setErr(null); setOwner(null); setQ("");
    api.giteaRepos(instance.name)
      .then((r) => { if (alive) setRepos(r.repos); })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [instance.name]);

  const owners = useMemo(() => deriveOwners(repos ?? []), [repos]);
  const filtered = useMemo(() => filterGiteaRepos(repos ?? [], owner, q), [repos, owner, q]);
  const src = owner ? ownerSource(owner) : undefined;

  return (
    <>
      {!instance.hasToken && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold text-destructive" role="alert">
          Instance has no token — private repos aren't visible.
          <span className="mt-1 block text-xs font-normal text-muted-foreground">Generate a token in Gitea (Settings → Applications → Access tokens, scopes read:repository + read:user) and add it in Config for this instance.</span>
        </div>
      )}
      {err && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold text-destructive" role="alert">
          Failed to load repositories
          <span className="mt-1 block text-xs font-normal text-muted-foreground">{err}</span>
        </div>
      )}

      {!err && (
        <>
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Owners</span>
          {repos === null ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2" aria-hidden="true">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[42px] rounded-lg" />)}
            </div>
          ) : owners.length === 0 ? (
            <p className="font-mono text-[11.5px] text-muted-foreground">The instance returned no repos{instance.hasToken ? "" : " — without a token only public ones are visible"}.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
              {owners.map((o) => (
                <button
                  key={o.login}
                  className={cn(
                    "flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-border/80 hover:bg-accent",
                    owner === o.login && "border-foreground/40 bg-accent",
                  )}
                  onClick={() => setOwner(owner === o.login ? null : o.login)}
                >
                  <span className="flex size-6 flex-none items-center justify-center rounded-full border font-mono text-xs font-semibold text-muted-foreground">{o.login.charAt(0).toUpperCase()}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-semibold" title={o.login}>{o.login}</span>
                  <Badge variant="outline" className="flex-none font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">{o.repoCount}×</Badge>
                </button>
              ))}
            </div>
          )}

          {owner && (src ? (
            <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 dark:border-emerald-400/40">
              <span className="min-w-40 flex-1 font-mono text-xs font-medium text-emerald-700 dark:text-emerald-400">✓ The whole owner {owner} is a source — repos load automatically</span>
              <Button variant="ghost" size="sm" onClick={() => onRemoveSource(owner)}>Remove source</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-dashed p-3">
              <span className="min-w-40 flex-1 font-mono text-xs font-medium text-muted-foreground">Add the whole owner {owner} as a source:</span>
              <Button variant="outline" size="sm" onClick={() => onAddSource(owner)}>Add source</Button>
            </div>
          ))}

          {repos !== null && (
            <>
              <div className="flex items-center gap-2.5">
                <Input
                  className="h-8 flex-1"
                  type="text"
                  placeholder={`Search repos on ${instance.name}…`}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Search repository"
                />
                <span className="flex-none font-mono text-xs tabular-nums text-muted-foreground">{filtered.length}/{repos.length}</span>
              </div>
              {filtered.length === 0 ? (
                <p className="font-mono text-[11.5px] text-muted-foreground">{repos.length === 0 ? "No repos." : "Nothing matches the filter."}</p>
              ) : (
                <div className="flex flex-none flex-col overflow-hidden rounded-lg border">
                  {filtered.map((r) => {
                    const added = isRepoAdded(r.fullName, r.cloneUrl);
                    const ts = Date.parse(r.updatedAt);
                    return (
                      <button
                        key={r.fullName}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2.5 border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent",
                          added && "bg-foreground/5",
                          r.isArchived && "opacity-55",
                        )}
                        onClick={() => onToggleRepo(r)}
                        title={added ? `Remove ${r.fullName} from ${target}` : `Add ${r.fullName} to ${target}`}
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
                        <span className="flex-none font-mono text-xs text-muted-foreground">{r.owner}</span>
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
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
