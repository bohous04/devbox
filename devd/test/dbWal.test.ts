import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, startCheckpointer } from "../src/db";

// Under disk saturation (agents' 13 GB checkouts) every rollback-journal commit waited minutes for
// fsync and blocked the single-threaded dashboard (18 Nov 2026). In WAL with synchronous=NORMAL a
// commit does not fsync; the only fsync left, the checkpoint, runs in a worker.
test("the live DB commits without fsync and leaves checkpoints to the worker", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "devd-wal-")), "devd.sqlite"));
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  expect((db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
  expect((db.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint).toBe(0);
  db.close();
});

test("the checkpoint worker moves committed data into the main file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devd-wal-"));
  const path = join(dir, "devd.sqlite");
  const db = openDb(path);
  db.run("CREATE TABLE t (v TEXT)");
  db.run("INSERT INTO t VALUES ('committed')");
  const worker = startCheckpointer(path, 20);
  try {
    // Only the main file, as a plain file copy would take it: the data must get there.
    let found: unknown = null;
    for (let i = 0; i < 60 && !found; i++) {
      await Bun.sleep(50);
      copyFileSync(path, join(dir, "copy.sqlite"));
      const copy = new Database(join(dir, "copy.sqlite")); // no -wal next to it
      try { found = copy.query("SELECT v FROM t").get(); } catch { /* table not checkpointed yet */ }
      copy.close();
    }
    expect(found).toEqual({ v: "committed" });
  } finally {
    worker.terminate();
    db.close();
  }
});

test("checkpointFully refuses when a reader keeps part of the WAL from the main file", () => {
  const { checkpointFully } = require("../src/db");
  const path = join(mkdtempSync(join(tmpdir(), "devd-wal-")), "devd.sqlite");
  const db = openDb(path);
  db.run("PRAGMA busy_timeout = 0");
  db.run("CREATE TABLE t (v TEXT)"); db.run("INSERT INTO t VALUES ('a')");
  const reader = new Database(path);
  reader.run("BEGIN"); reader.query("SELECT * FROM t").all();   // snapshot pins the WAL
  db.run("INSERT INTO t VALUES ('b')");
  expect(() => checkpointFully(db)).toThrow(/checkpoint incomplete/);
  reader.run("COMMIT");
  expect(() => checkpointFully(db)).not.toThrow();
  reader.close(); db.close();
});

test("a restored DB is swapped in before opening, without the old WAL", () => {
  const { applyPendingRestore } = require("../src/db");
  const dir = mkdtempSync(join(tmpdir(), "devd-wal-"));
  const path = join(dir, "devd.sqlite");
  const live = openDb(path); live.run("CREATE TABLE t (v TEXT)"); live.run("INSERT INTO t VALUES ('old')"); live.close();
  const restored = new Database(join(dir, "r.sqlite")); restored.run("CREATE TABLE t (v TEXT)"); restored.run("INSERT INTO t VALUES ('restored')"); restored.close();
  copyFileSync(join(dir, "r.sqlite"), `${path}.restore`);
  expect(applyPendingRestore(path)).toBe(true);
  const db = openDb(path);
  expect(db.query("SELECT v FROM t").all()).toEqual([{ v: "restored" }]);
  expect(applyPendingRestore(path)).toBe(false);
  const previous = new Database(`${path}.pre-restore`); // the replaced DB, its WAL alongside
  expect(previous.query("SELECT v FROM t").all()).toEqual([{ v: "old" }]);
  previous.close();
  db.close();
});
