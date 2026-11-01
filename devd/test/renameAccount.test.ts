import { expect, test } from "bun:test";
import { renamePlan } from "../../tools/rename-account";

// Default state = a healthy move. Individual tests override only the field they examine.
const OK = {
  oldId: "primary", newId: "max5",
  oldInDb: true, newInDb: false,
  oldVolume: true, newVolume: false,
  busyContainers: 0,
};
const plan = (over: Partial<typeof OK> & { allowBusy?: boolean; refCount?: number } = {}) => renamePlan({ ...OK, ...over });

test("healthy state → rename", () => {
  const p = plan();
  expect(p.action).toBe("rename");
  expect(p.reason).toBe("primary → max5");
});

test("idempotence: target in the DB and the source no longer → already-done, not an error", () => {
  // The migration is commonly rerun after an interruption; the second run must not fail.
  expect(plan({ oldInDb: false, newInDb: true }).action).toBe("already-done");
});

test("refuses to overwrite an existing id", () => {
  const p = plan({ newInDb: true });
  expect(p.action).toBe("refuse");
  expect(p.reason).toContain("already exists");
});

test("refuses when the source is not in the DB and the target is not either", () => {
  expect(plan({ oldInDb: false }).action).toBe("refuse");
});

test("refuses a missing source volume", () => {
  expect(plan({ oldVolume: false }).action).toBe("refuse");
});

test("refuses leftovers of an interrupted migration (the target volume exists)", () => {
  // Deleting it blindly is not possible — the content may be half copied and we cannot tell.
  const p = plan({ newVolume: true });
  expect(p.action).toBe("refuse");
  expect(p.reason).toContain("interrupted migration");
});

test("refuses when the volume is held by running containers", () => {
  // The recreate is unavoidable, but it must happen BEFORE the migration — otherwise the session
  // is left with a dead mount and CLAUDE_CONFIG_DIR pointing to a non-existent path.
  const p = plan({ busyContainers: 3 });
  expect(p.action).toBe("refuse");
  expect(p.reason).toContain("3 running containers");
});

test("refuses invalid ids (they go into the volume name and the mount path)", () => {
  expect(plan({ newId: "../../etc" }).action).toBe("refuse");
  expect(plan({ newId: "max_20" }).action).toBe("refuse");     // underscore outside the whitelist
  expect(plan({ oldId: "" }).action).toBe("refuse");
  expect(plan({ oldId: "max5", newId: "max5" }).action).toBe("refuse");
});

test("order of checks: id validity first, state only then (an invalid id must not pass as already-done)", () => {
  const p = plan({ newId: "invalid!", oldInDb: false, newInDb: true });
  expect(p.action).toBe("refuse");
  expect(p.reason).toContain("invalid new id");
});

// ---------------------------------------------------------------------------
// --allow-busy: migration without downtime. Nothing changes for running agents (their
// CLAUDE_CONFIG_DIR points to the old path, which stays mounted) and a new session
// in such a container falls back via fail-open to the shared claude-home.
// ---------------------------------------------------------------------------

test("without --allow-busy running containers refuse the migration", () => {
  const p = plan({ busyContainers: 2 });
  expect(p.action).toBe("refuse");
  expect(p.reason).toContain("--allow-busy");
});

test("with --allow-busy the migration runs, but the old volume is NOT DELETED", () => {
  const p = plan({ busyContainers: 2, allowBusy: true });
  expect(p.action).toBe("rename");
  expect(p.deleteOld).toBe(false);
});

test("without running containers the old volume is deleted even with --allow-busy", () => {
  // --allow-busy is a permission, not an order to leave a mess: when nobody holds the volume,
  // the cleanup runs normally.
  expect(plan({ busyContainers: 0, allowBusy: true }).deleteOld).toBe(true);
  expect(plan({ busyContainers: 0 }).deleteOld).toBe(true);
});

test("--allow-busy does not override the other checks", () => {
  expect(plan({ newInDb: true, allowBusy: true }).action).toBe("refuse");
  expect(plan({ newVolume: true, allowBusy: true }).action).toBe("refuse");
  expect(plan({ newId: "invalid!", allowBusy: true }).action).toBe("refuse");
});

test("cleanup is governed by ALL references, not just running containers", () => {
  // Regression from the live migration: `docker ps -q` sees only running ones, but `docker volume rm`
  // is blocked by a stopped container too. The plan therefore reported deleteOld=true and the deletion then
  // failed with "volume is in use".
  const p = plan({ busyContainers: 0, refCount: 1 });
  expect(p.action).toBe("rename");
  expect(p.deleteOld).toBe(false);
});

test("a missing refCount is derived from busyContainers (older callers do not break)", () => {
  expect(plan({ busyContainers: 0 }).deleteOld).toBe(true);
  expect(plan({ busyContainers: 2, allowBusy: true }).deleteOld).toBe(false);
});
