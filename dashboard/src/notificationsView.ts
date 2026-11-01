import type { NotifyLogRow } from "./api";

// A user_prompt_submit row is a turn divider (spec §6): header carries the turn that
// rows belong to (the other rows of the turn, newest first). header is null for rows whose
// divider did not make it into the visible window — either the page cut it off by the limit, or
// the active filter removed it (e.g. "only sent" does not show prompt rows).
export interface TurnGroup { key: string; header: NotifyLogRow | null; rows: NotifyLogRow[] }

// The API returns rows descending (newest first) across ALL sessions at once — splitting
// into turns must therefore respect session_id too, otherwise concurrent sessions would mix
// rows of other turns into one block.
export function groupByTurn(rows: NotifyLogRow[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let bucket: NotifyLogRow[] = [];
  let bucketSession: string | null = null;
  const flushTail = () => {
    if (bucket.length) groups.push({ key: `tail-${bucket[0].id}`, header: null, rows: bucket });
    bucket = [];
  };
  for (const r of rows) {
    if (bucketSession !== null && r.session_id !== bucketSession) flushTail();
    bucketSession = r.session_id;
    if (r.event === "user_prompt_submit") {
      groups.push({ key: `turn-${r.id}`, header: r, rows: bucket });
      bucket = [];
      bucketSession = null;
    } else {
      bucket.push(r);
    }
  }
  flushTail();
  return groups;
}

export function promptExcerpt(row: NotifyLogRow): string | null {
  if (!row.detail) return null;
  try { return (JSON.parse(row.detail) as { prompt?: string }).prompt ?? null; }
  catch { return null; }
}
