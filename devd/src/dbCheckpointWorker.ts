// Checkpoints the devd DB off the main thread: the checkpoint is the only fsync left in WAL mode,
// and under disk saturation it can take minutes — on the main thread that froze the dashboard.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ path: string; intervalMs: number }>) => {
  const db = new Database(e.data.path);
  db.run("PRAGMA busy_timeout = 5000");
  setInterval(() => {
    try {
      db.run("PRAGMA wal_checkpoint(PASSIVE)");
      const wal = statSync(`${e.data.path}-wal`, { throwIfNoEntry: false })?.size ?? 0;
      if (wal > 1024 ** 3) console.error(`devd db WAL is ${Math.round(wal / 1024 ** 2)} MB: checkpoints are not keeping up`);
    } catch (err) {
      console.error(`devd db checkpoint failed: ${(err as Error).message}`);
    }
  }, e.data.intervalMs);
};
