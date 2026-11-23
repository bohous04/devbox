/** The row OlderItems keeps in place: its key (MessageList data-row-key), its run, and where it was on screen. */
export interface RowAnchor { key: string; run: string | null; top: number }

/** The anchor's row among `rows` after the load, else the fold its run became (a run whole only now folds its work). */
export function anchorRow<T extends { dataset: DOMStringMap }>(rows: T[], a: RowAnchor): T | null {
  const find = (key: string) => rows.find((r) => r.dataset.rowKey === key) ?? null;
  return find(a.key) ?? (a.run !== null ? find(`work:${a.run}`) : null);
}
