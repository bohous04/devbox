import type { SessionRow } from "./db";

export interface RecoveryOperations {
  get(): SessionRow | null;
  hasStopIntent(row: SessionRow): boolean;
  markStopped(row: SessionRow): void;
  hasWorkspace(row: SessionRow): boolean;
  workspace(row: SessionRow): string;
  inspect(row: SessionRow): Promise<{ state: "running" | "stopped" | "missing"; workspace?: string }>;
  ensureDind(row: SessionRow): Promise<void>;
  hasJournal(row: SessionRow): boolean;
  create(row: SessionRow): Promise<void>;
  start(row: SessionRow): Promise<void>;
  ready(row: SessionRow): Promise<void>;
  restored(row: SessionRow, recreated: boolean): void;
}

/** The startup lifecycle, called while SessionManager holds its shared ID lock. */
export async function recoverManagedSession(ops: RecoveryOperations): Promise<void> {
  const row = ops.get();
  if (!row || row.status !== "running") return;
  if (ops.hasStopIntent(row)) { ops.markStopped(row); return; }
  if (!ops.hasWorkspace(row)) throw new Error("Recorded recovery workspace is missing");
  const before = await ops.inspect(row);
  const workspace = ops.workspace(row);
  if (before.state !== "missing" && before.workspace !== workspace) {
    throw new Error("Recovery container workspace differs from its session row");
  }
  if (before.state === "missing" && !ops.hasJournal(row)) {
    throw new Error("Missing container has no exact recovery journal");
  }
  await ops.ensureDind(row);
  if (before.state === "running") { await ops.ready(row); return; }
  if (before.state === "missing") await ops.create(row);
  else await ops.start(row);
  const after = await ops.inspect(row);
  if (after.state !== "running" || after.workspace !== workspace) {
    throw new Error("Recovered container did not become ready at its recorded workspace");
  }
  await ops.ready(row);
  ops.restored(row, before.state === "missing");
}

/** Retry startup recovery without treating a Docker outage as intentional stop.
 * The immutable startup list prevents resurrecting sessions opened/ended later.
 * Each manager call rechecks the row while holding its ordinary lifecycle lock.
 */
export function startRecovery(deps: {
  ids: string[];
  recover: (id: string) => Promise<void>;
  failed?: (id: string, error: unknown) => void;
  delayMs?: number;
  maxAttempts?: number;
}): { done: Promise<string[]>; cancel: () => void } {
  let cancelled = false;
  const done = (async () => {
    let pending = [...new Set(deps.ids)];
    for (let attempt = 0; pending.length && !cancelled && attempt < (deps.maxAttempts ?? 10); attempt++) {
      const failed: string[] = [];
      for (const id of pending) {
        if (cancelled) break;
        try { await deps.recover(id); }
        catch (error) { failed.push(id); deps.failed?.(id, error); }
      }
      pending = failed;
      if (pending.length && attempt + 1 < (deps.maxAttempts ?? 10) && !cancelled) {
        await Bun.sleep(deps.delayMs ?? 30_000);
      }
    }
    return pending;
  })();
  return { done, cancel: () => { cancelled = true; } };
}
