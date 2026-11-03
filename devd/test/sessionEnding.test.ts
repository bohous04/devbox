import { expect, test } from "bun:test";
import { SessionManager } from "../src/sessions";
import { openDb } from "../src/db";
import { DEFAULT_CONFIG } from "../src/config";

test("ending status follows the actual end operation and clears on success or failure", async () => {
  const db = openDb(":memory:");
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root: "/tmp", image: "unused", extraMounts: [], cmd: [] });
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const pending = mgr.withLock(["dev-apps-web"], "end", () => wait);
  expect(mgr.isEnding("dev-apps-web")).toBe(true);
  expect(mgr.isEnding("dev-apps-other")).toBe(false);
  finish(); await pending;
  expect(mgr.isEnding("dev-apps-web")).toBe(false);
  await expect(mgr.withLock(["dev-apps-web"], "end", async () => { throw new Error("backup failed"); })).rejects.toThrow("backup failed");
  expect(mgr.isEnding("dev-apps-web")).toBe(false);
  await mgr.withLock(["dev-apps-web"], "stop", async () => { expect(mgr.isEnding("dev-apps-web")).toBe(false); });
  db.close();
});
