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
}
