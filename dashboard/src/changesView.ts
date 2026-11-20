import type { RunRow, ThreadItem } from "../../shared/thread";
import type { ChangedFile, ChangeStatus, SessionChanges } from "../../shared/changes";
import { ApiError } from "./api";

// The changed-files card under the thread's latest answer: what it says and when it refetches. It shows the
// worktree's current state against a base, not one turn's changes, so its label names the base.

/** "3 changed files" / "1 changed file", from devd's totals (which count every file even when the list is cut short). */
export function changesTitle(c: SessionChanges): string {
  const n = c.totals.files;
  return `${n} changed ${n === 1 ? "file" : "files"}`;
}

/** A file's line counts: "+12 −3", or "not counted" when devd has none. That is a binary file, or an untracked one
 *  devd did not read (too large, over its cap, not a regular file): which of the two only its diff tells. */
export function fileStat(f: ChangedFile): { added: number; removed: number } | "not counted" {
  return f.added === null || f.removed === null ? "not counted" : { added: f.added, removed: f.removed };
}

/** devd left some untracked files' lines out of the totals (its read cap, or the counter could not run). */
export const countsIncomplete = (c: SessionChanges): boolean => c.countsCapped === true || c.countsUnavailable === true;

const STATUS_LETTER: Record<ChangeStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U" };
export const statusLetter = (s: ChangeStatus): string => STATUS_LETTER[s];

/** Directory and name apart, so a long path truncates its directory and keeps the file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** The item the card sits under: the latest finished run's last assistant message, while no run is running or
 *  queued (a newer turn is coming). Its run's end seq is the refetch key. null: no card. */
export function changesAnchor(items: ThreadItem[], runs: RunRow[]): { item: ThreadItem; endedSeq: number | null } | null {
  if (runs.some((r) => r.status === "running" || r.status === "queued")) return null;
  const last = runs.filter((r) => r.endedAt !== null).sort((a, b) => (a.endedSeq ?? 0) - (b.endedSeq ?? 0)).at(-1);
  if (!last) return null;
  const item = items.findLast((i) => i.kind === "assistant" && i.runId === last.runId);
  return item ? { item, endedSeq: last.endedSeq } : null;
}

/** The error line's text, or null for no card at all: a repository without commits has nothing to compare, which
 *  is not a failure (devd answers 409 with this exact message). */
export function changesError(e: unknown): string | null {
  if (e instanceof ApiError && e.status === 409 && e.message === "repository has no commits yet") return null;
  return (e as Error).message;
}

/** Files listed under their folder, folders in first-seen order; a folder's +/− sums its files' line counts
 *  (binary files have none and add nothing). Files at the root form a group with dir "". */
export interface FolderGroup { dir: string; added: number; removed: number; files: ChangedFile[] }
export function groupByFolder(files: ChangedFile[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const f of files) {
    const dir = splitPath(f.path).dir;
    let g = groups.get(dir);
    if (!g) { g = { dir, added: 0, removed: 0, files: [] }; groups.set(dir, g); }
    g.files.push(f);
    g.added += f.added ?? 0;
    g.removed += f.removed ?? 0;
  }
  return [...groups.values()];
}

/** The list starts open when it is short enough to read at a glance. */
export const CHANGES_OPEN_MAX = 6;
