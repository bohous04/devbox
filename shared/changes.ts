/** GET /api/sessions/:id/changes — the session worktree's changes against `base`. */
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** null = not counted (binary, or an untracked file too large / not a regular file). */
  added: number | null;
  removed: number | null;
  /** Only for `renamed`. */
  oldPath?: string;
  /** The name is not valid UTF-8 (shown with U+FFFD); an untracked one is then not counted. */
  nameNotUtf8?: true;
}

export interface SessionChanges {
  /** What was compared: the upstream (e.g. "origin/feat"), origin's default branch ("origin/main"),
   *  or "HEAD" when neither exists (only uncommitted changes then). */
  base: string;
  files: ChangedFile[];
  /** Over ALL changed files, also those cut off by `truncated`; null counts are left out. */
  totals: { files: number; added: number; removed: number };
  /** Present when `files` was capped. */
  truncated?: true;
  /** Present when devd stopped reading untracked files (per-request file or byte cap), so the
   *  totals miss their lines. */
  countsCapped?: true;
  /** Present when untracked files could not be counted at all (the counter could not run); their
   *  counts are null and the totals miss their lines. */
  countsUnavailable?: true;
}

/** Why a changes route (or the files route) refused. `error` is for people and may be reworded; `code` is stable. A refusal
 *  from a guard in front of every route (the shared-session guard, 403) comes without a code. */
export type ChangesErrorCode =
  | "unknown_session" | "instabox" | "restricted"
  | "worktree_missing" | "not_a_repo" | "foreign_git_dir" | "no_commits" | "root_owned"
  | "invalid_path" | "not_changed" | "unreadable_file" | "invalid_limit"
  | "git_failed" | "read_failed";

export interface ChangesErrorBody {
  error: string;
  code: ChangesErrorCode;
}

/** GET /api/sessions/:id/changes/diff?path= — one changed file's unified diff against `base`. */
export interface FileDiff {
  path: string;
  status: ChangeStatus;
  base: string;
  /** Binary file: `diff` is empty. */
  binary: boolean;
  /** `diff` was cut at 256 KB on a line boundary. */
  truncated: boolean;
  diff: string;
}

/** GET /api/sessions/:id/files?q=&limit= — files of the session repo for the composer's @ picker (repo-relative
 *  paths, tracked and untracked, not ignored). Refusals as for the changes routes (ChangesErrorBody). devd reuses one
 *  listing per session for 10 s, so a file created in that time shows up only after it. */
export interface SessionFiles {
  files: string[];
  /** More files matched than `limit`. */
  more?: true;
  /** The repo lists more names than devd reads (about 4 MB of them): files past that point were not searched. */
  listingCapped?: true;
}
