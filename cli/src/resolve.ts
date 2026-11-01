import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentName } from "../../devd/src/db";
import type { TreeProject } from "../../devd/src/tree";

// `bare` = the repo is in the new layout, so each session on it gets its own worktree
// and branch (see freshLabel). Carried all the way here so the menu does not promise isolation
// where the session will not get it.
export interface Target { folder: string; project: string; repo: string; cloneUrl?: string; cloned: boolean; bare?: boolean; agent?: AgentName | null }

export function flattenTree(tree: TreeProject[]): Target[] {
  return tree.flatMap((p) =>
    p.repos.map((r) => ({ folder: p.folder, project: p.project, repo: r.name, cloneUrl: r.cloneUrl, cloned: r.cloned, bare: r.bare, agent: r.agent ?? null }))
  );
}

/** Session matched by the query `dev <command> <target>`. An exact `id` is always unambiguous
 *  and wins — clicking a notification runs `dev attach <id>` and that must not ask anything.
 *  A `project/repo` query, on the other hand, STOPPED being unambiguous (second session of the same repo), so
 *  it returns all matches and leaves the decision to the caller.
 *
 *  Previously the first one was silently taken, which per `listSessions` (ORDER BY created_at) was the
 *  OLDEST — and since `end()` deletes the session's working directory, that would mean
 *  silently destroying unfinished work in a session the user did not mean. Generic over T so that
 *  both SessionInfo and a bare row fit. */
export function matchSessions<T extends { id: string; project: string; repo: string }>(sessions: T[], query: string): T[] {
  const byId = sessions.find((s) => s.id === query);
  if (byId) return [byId];
  return sessions.filter((s) => `${s.project}/${s.repo}` === query);
}

export function resolveQuery(targets: Target[], query: string): Target[] {
  const [a, b] = query.split("/");
  return targets.filter((t) => (b !== undefined ? t.project === a && t.repo === b : t.repo === a));
}

export interface RecentsStore { load(): Target[]; touch(t: Target): void }

export function fileRecents(path: string): RecentsStore {
  const load = (): Target[] => {
    if (!existsSync(path)) return [];
    try { return JSON.parse(readFileSync(path, "utf8")) as Target[]; }
    catch { return []; }
  };
  return {
    load,
    touch(t: Target) {
      const rest = load().filter((r) => !(r.project === t.project && r.repo === t.repo));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([t, ...rest].slice(0, 20), null, 2) + "\n");
    },
  };
}

export function sortByRecent(targets: Target[], recents: Target[]): Target[] {
  const key = (t: Target) => `${t.project}/${t.repo}`;
  const rank = new Map(recents.map((r, i) => [key(r), i]));
  return [...targets].sort((x, y) => {
    const rx = rank.get(key(x)) ?? Infinity;
    const ry = rank.get(key(y)) ?? Infinity;
    return rx !== ry ? rx - ry : key(x).localeCompare(key(y));
  });
}

export interface AttachedRecord { id: string; ts: number }
export interface LastAttachedStore { load(): AttachedRecord[]; touch(id: string, now: number): void }

// Where you last attached (fallback when the loop dies: Warp restart, Ctrl-C). Last
// 20, newest first. Corrupted file → empty (never fails because of metadata).
export function fileLastAttached(path: string): LastAttachedStore {
  const load = (): AttachedRecord[] => {
    if (!existsSync(path)) return [];
    try { return JSON.parse(readFileSync(path, "utf8")) as AttachedRecord[]; }
    catch { return []; }
  };
  return {
    load,
    touch(id: string, now: number) {
      const rest = load().filter((r) => r.id !== id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([{ id, ts: now }, ...rest].slice(0, 20), null, 2) + "\n");
    },
  };
}
