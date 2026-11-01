// Approval queue logic separate from the component — the dashboard has no component tests,
// the pure function is tested (same as hardwareView, accountsView and co.).
export interface OpRow {
  id: number; ts: number; session_id: string | null; op: string; params: string;
  status: string; decided_at: number | null; result: string | null; error: string | null;
}

/** Pending ones on top, otherwise newest first — the queue is read top-down. Returns a NEW array,
 *  so what React holds in state is not reordered. */
export function pendingFirst(rows: OpRow[]): OpRow[] {
  return [...rows].sort((a, b) =>
    (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.id - a.id);
}

/** One-line summary for the approval screen. Unreadable parameters must not bring down
 *  the page — the proposal must still be rejectable. */
export function opSummary(r: OpRow): string {
  try {
    const p = JSON.parse(r.params) as Record<string, string>;
    const pairs = Object.entries(p).filter(([key]) => !["changes", "fingerprint", "idempotencyKey"].includes(key)).map(([k, v]) => `${k}=${v}`).join(", ");
    return pairs ? `${r.op} · ${pairs}` : r.op;
  } catch { return `${r.op} · (unreadable parameters)`; }
}

/** Structured display for the prepared deployment and its exact SQL dependency. */
export function operationReview(r: OpRow): { changes: string[]; afterWrite: number | null; requestId: number | null; problem: string | null } {
  try {
    const p = JSON.parse(r.params);
    const changes = typeof p.changes === "string" ? JSON.parse(p.changes) : [];
    if (!Array.isArray(changes) || changes.some((value) => typeof value !== "string")) throw new Error("Invalid changes");
    const number = (value: unknown) => typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : null;
    return { changes, afterWrite: number(p.afterWrite), requestId: number(p.requestId), problem: null };
  } catch { return { changes: [], afterWrite: null, requestId: null, problem: "Prepared operation details could not be read. Prepare the operation again before approval." }; }
}

export function operationStatus(r: OpRow): string {
  const review = operationReview(r);
  if (r.status === "approved" && review.afterWrite) return `Approved · waiting for SQL #${review.afterWrite}`;
  return ({ pending: "Awaiting approval", approved: "Approved · queued", running: "Running", executed: "Executed", failed: "Failed", rejected: "Rejected" } as Record<string, string>)[r.status] || r.status;
}
