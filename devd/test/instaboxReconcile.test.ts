import { expect, test } from "bun:test";
import { getSession, insertSession, openDb, setInstaboxBase } from "../src/db";
import { addInstaboxIp, clearInstaboxIps, isInstaboxAddress } from "../src/network";
import { createStatusCache, killOrphan, reconcile, type IbxStatus } from "../src/instabox/reconcile";
import { FakeInstaboxClient } from "./helpers/instaboxFake";

const row = { folder: "f", project: "p", status: "running" as const, solo: 0 as const, created_at: 1, last_active_at: 1, important: 0 as const, host: "instabox" as const };

test("orphans, lost, stale base and counts including a foreign machine", async () => {
  const db = openDb(":memory:");
  const c = new FakeInstaboxClient();
  c.foreignMachines = 1;
  const a = await c.create("sn", { name: "a", metadata: { devbox: "1", session: "dev-p-a" } });
  await c.create("sn", { name: "orph", metadata: { devbox: "1", session: "dev-p-zzz" } });
  insertSession(db, { ...row, id: "dev-p-a", repo: "a", container: "dev-p-a", port_base: 40100, instabox_machine_id: a.id });
  insertSession(db, { ...row, id: "dev-p-b", repo: "b", container: "dev-p-b", port_base: 40110, instabox_machine_id: "m_gone" });
  setInstaboxBase(db, { snapshot_id: "sn", image_digest: "sha256:old", built_at: 5 });
  const s = await reconcile(db, c, async () => "sha256:new");
  expect(s.ok).toBe(true);
  expect(s.machines).toBe(3);        // 2 devbox + foreign vps02
  expect(s.devboxMachines).toBe(2);
  expect(s.orphans.map((o) => o.name)).toEqual(["orph"]);
  expect(s.lost).toEqual(["dev-p-b"]);
  expect(s.base).toEqual({ snapshotId: "sn", builtAt: 5, stale: true });
});

test("API error → ok:false, does not throw", async () => {
  const db = openDb(":memory:");
  const c = new FakeInstaboxClient();
  c.failNext.set("list", new Error("503 upstream"));
  const s = await reconcile(db, c, async () => null);
  expect(s.ok).toBe(false);
  expect(s.error).toContain("503");
  expect(s.orphans).toEqual([]);
  expect(s.base).toBeNull();
});

test("killOrphan deletes only a devbox=1 machine without a session — not a session, a running base-build or a foreign machine", async () => {
  const db = openDb(":memory:");
  const c = new FakeInstaboxClient();
  const owned = await c.create("sn", { name: "a", metadata: { devbox: "1", session: "dev-p-a" } });
  const orphan = await c.create("sn", { name: "orph", metadata: { devbox: "1", session: "dev-p-zzz" } });
  const base = await c.create("agent-browser", { name: "devbox-base-build", metadata: { devbox: "base-build" } });
  const foreign = await c.create("x", { name: "vps02", metadata: {} });
  insertSession(db, { ...row, id: "dev-p-a", repo: "a", container: "dev-p-a", port_base: 40100, instabox_machine_id: owned.id });
  // the base-build machine is protected while the build runs (I5b) — without a running build it is a leftover.
  for (const id of [owned.id, base.id, foreign.id, "m_missing"]) expect(await killOrphan(db, c, id, { buildRunning: () => true })).toBe(false);
  expect(c.calls.filter((x) => x.startsWith("kill"))).toEqual([]);
  expect(await killOrphan(db, c, orphan.id)).toBe(true);
  expect(c.calls.filter((x) => x.startsWith("kill"))).toEqual([`kill ${orphan.id}`]);
  expect([...c.machines.keys()].sort()).toEqual([owned.id, base.id, foreign.id].sort());
});

test("killOrphan throws when the API is down (route → 502), deletes nothing", async () => {
  const db = openDb(":memory:");
  const c = new FakeInstaboxClient();
  const orphan = await c.create("sn", { name: "orph", metadata: { devbox: "1", session: "dev-p-zzz" } });
  c.failNext.set("list", new Error("503 upstream"));
  await expect(killOrphan(db, c, orphan.id)).rejects.toThrow("503");
  expect(c.machines.has(orphan.id)).toBe(true);
});

test("createStatusCache: returns the cache within 30 s, then recomputes; concurrent calls share one computation", async () => {
  let t = 1000, n = 0;
  const st = (i: number) => ({ enabled: true, ok: true, machines: i } as unknown as IbxStatus);
  const cache = createStatusCache(async () => { n++; await Bun.sleep(1); return st(n); }, 30_000, () => t);
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  expect(n).toBe(1);
  expect(a).toBe(b);
  t += 29_000;
  expect((await cache.get()).machines).toBe(1);
  expect(n).toBe(1);
  t += 2_000;
  expect((await cache.get()).machines).toBe(2);
  await cache.refresh();
  expect(n).toBe(3);
  expect(cache.current()!.machines).toBe(3);
});

test("I5a: orphan status by machine id, not by metadata.session (recycled session id)", async () => {
  const db = openDb(":memory:");
  const c = new FakeInstaboxClient();
  // Old machine of the ended session dev-p-a (kill failed), the session id was recycled for a new one.
  const old = await c.create("sn", { name: "old", metadata: { devbox: "1", session: "dev-p-a" } });
  const cur = await c.create("sn", { name: "cur", metadata: { devbox: "1", session: "dev-p-a" } });
  insertSession(db, { ...row, id: "dev-p-a", repo: "a", container: "dev-p-a", port_base: 40100, instabox_machine_id: cur.id });
  // A create that has not recorded the machine id yet: a machine with its metadata is NOT an orphan.
  const creating = await c.create("sn", { name: "new", metadata: { devbox: "1", session: "dev-p-n" } });
  insertSession(db, { ...row, id: "dev-p-n", repo: "n", container: "dev-p-n", port_base: 40110 });
  const s = await reconcile(db, c, async () => null);
  expect(s.orphans.map((o) => o.id)).toEqual([old.id]);
  expect(await killOrphan(db, c, cur.id)).toBe(false);
  expect(await killOrphan(db, c, creating.id)).toBe(false);
  expect(await killOrphan(db, c, old.id)).toBe(true);
  expect([...c.machines.keys()].sort()).toEqual([cur.id, creating.id].sort());
});

test("I5b: base-build machines without a running build are buildLeftovers and can be deleted; not during a build", async () => {
  const db = openDb(":memory:");
  const c = new FakeInstaboxClient();
  const base = await c.create("agent-browser", { name: "devbox-base-build", metadata: { devbox: "base-build" } });
  const idle = await reconcile(db, c, async () => null, { buildRunning: () => false });
  expect(idle.buildLeftovers).toEqual([{ id: base.id, name: "devbox-base-build", state: "running" }]);
  expect(idle.orphans).toEqual([]);
  const busy = await reconcile(db, c, async () => null, { buildRunning: () => true });
  expect(busy.buildLeftovers).toEqual([]);
  expect(await killOrphan(db, c, base.id, { buildRunning: () => true })).toBe(false);
  expect(c.machines.has(base.id)).toBe(true);
  expect(await killOrphan(db, c, base.id)).toBe(true);
  expect(c.machines.has(base.id)).toBe(false);
});

test("C1: lost session → reconcile forgets the machine's tailnet IP (in memory and in the DB); a live IP stays", async () => {
  clearInstaboxIps();
  const db = openDb(":memory:");
  const c = new FakeInstaboxClient();
  const live = await c.create("sn", { name: "a", metadata: { devbox: "1", session: "dev-p-a" } });
  insertSession(db, { ...row, id: "dev-p-a", repo: "a", container: "dev-p-a", port_base: 40100, instabox_machine_id: live.id });
  insertSession(db, { ...row, id: "dev-p-b", repo: "b", container: "dev-p-b", port_base: 40110, instabox_machine_id: "m_gone" });
  db.run("UPDATE sessions SET instabox_ts_ip='100.100.0.1' WHERE id='dev-p-a'");
  db.run("UPDATE sessions SET instabox_ts_ip='100.100.0.9' WHERE id='dev-p-b'");
  addInstaboxIp("100.100.0.1");
  addInstaboxIp("100.100.0.9");
  const s = await reconcile(db, c, async () => null);
  expect(s.lost).toEqual(["dev-p-b"]);
  expect(isInstaboxAddress("100.100.0.9")).toBe(false);
  expect(getSession(db, "dev-p-b")!.instabox_ts_ip).toBeNull();
  expect(isInstaboxAddress("100.100.0.1")).toBe(true);
  expect(getSession(db, "dev-p-a")!.instabox_ts_ip).toBe("100.100.0.1");
  clearInstaboxIps();
});
