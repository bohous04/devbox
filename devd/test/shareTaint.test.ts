import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { deleteSession, insertSession, openDb, type SessionRow } from "../src/db";
import { SessionManager } from "../src/sessions";
import {
  dockerContainerId, isTainted, markTainted, pruneTaints, sessionsWithTaint, stopDindSidecar, taintedContainerIds,
} from "../src/shareTaint";
import type { RunResult } from "../src/proc";

const BASE: Omit<SessionRow, "id" | "repo" | "container" | "port_base" | "host"> = {
  folder: "f", project: "p", status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};
let port = 43000;
function add(db: ReturnType<typeof openDb>, id: string) {
  insertSession(db, { ...BASE, id, repo: id, container: id, port_base: port++, host: "vps" });
}
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr, timedOut: false });

test("isTainted: applies only to the shared container; non-existent = no; unknown id = fail-closed", () => {
  const db = openDb(":memory:");
  add(db, "s");
  expect(isTainted(db, "s", undefined)).toBe(false); // nothing without a taint
  markTainted(db, "s", "cid-1");
  markTainted(db, "s", "cid-1"); // idempotent
  expect(taintedContainerIds(db, "s")).toEqual(["cid-1"]);
  expect(isTainted(db, "s", "cid-1")).toBe(true);
  expect(isTainted(db, "s", "cid-2")).toBe(false); // rebuilt container
  expect(isTainted(db, "s", null)).toBe(false);    // container does not exist
  expect(isTainted(db, "s", undefined)).toBe(true); // we don't know → restricted
  expect([...sessionsWithTaint(db)]).toEqual(["s"]);
});

test("pruneTaints: cleans up rebuilt containers and deleted sessions, keeps ones missing from the map", () => {
  const db = openDb(":memory:");
  add(db, "a"); add(db, "b"); add(db, "c"); add(db, "gone");
  markTainted(db, "a", "cid-a-old");
  markTainted(db, "b", "cid-b");
  markTainted(db, "c", "cid-c");
  markTainted(db, "gone", "cid-gone");
  deleteSession(db, "gone");
  const removed = pruneTaints(db, new Map([["a", "cid-a-new"], ["b", "cid-b"]]));
  expect(removed).toBe(2);
  expect(taintedContainerIds(db, "a")).toEqual([]);
  expect(taintedContainerIds(db, "b")).toEqual(["cid-b"]);
  expect(taintedContainerIds(db, "c")).toEqual(["cid-c"]); // missing from the map → keep
});

test("dockerContainerId: id, non-existent container → null, other error → exception", async () => {
  expect(await dockerContainerId("x", async () => ok("abc123\n"))).toBe("abc123");
  expect(await dockerContainerId("x", async () => fail("Error: No such container: x"))).toBeNull();
  await expect(dockerContainerId("x", async () => fail("Cannot connect to the Docker daemon"))).rejects.toThrow("Docker daemon");
});

test("stopDindSidecar: stops and verifies; running after stop or a stop error → exception", async () => {
  const calls: string[][] = [];
  await stopDindSidecar("s", async (cmd) => { calls.push(cmd); return cmd[1] === "stop" ? ok("dind-s") : ok("false\n"); });
  expect(calls[0]).toEqual(["docker", "stop", "dind-s"]);
  expect(calls[1]).toContain("{{.State.Running}}");
  // Sidecar does not exist at all → fine.
  await stopDindSidecar("s", async () => fail("Error response from daemon: No such container: dind-s"));
  await expect(stopDindSidecar("s", async (cmd) => (cmd[1] === "stop" ? ok() : ok("true")))).rejects.toThrow("still running");
  await expect(stopDindSidecar("s", async () => fail("permission denied"))).rejects.toThrow("permission denied");
});

/* ==================== SessionManager.ensureDind: shared/tainted session without a sidecar ==================== */

const savedPath = process.env.PATH;
afterEach(() => { process.env.PATH = savedPath; });

/** Fake `docker` in PATH: writes argv to the log, `exec … version` returns a version. */
function fakeDocker(): { log: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  const log = join(dir, "log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1" in exec) echo 27.0;; esac\nexit 0\n`);
  chmodSync(join(dir, "docker"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  return { log: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

function manager(restricted: () => Promise<boolean>) {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "taint-root-"));
  return new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", dind: true, shareRestricted: restricted });
}

test("ensureDind: restricted session → the sidecar is only stopped, never started", async () => {
  const docker = fakeDocker();
  const mgr = manager(async () => true);
  await (mgr as unknown as { ensureDind(id: string, req?: boolean): Promise<void> }).ensureDind("dev-x", true);
  expect(docker.log()).toEqual(["stop dind-dev-x"]);
});

test("ensureDind: error while checking the share = fail-closed (sidecar does not start)", async () => {
  const docker = fakeDocker();
  const mgr = manager(async () => { throw new Error("docker inspect failed"); });
  await (mgr as unknown as { ensureDind(id: string): Promise<void> }).ensureDind("dev-x");
  expect(docker.log()).toEqual(["stop dind-dev-x"]);
});

test("ensureDind: unrestricted session → the sidecar is built and started as before", async () => {
  const docker = fakeDocker();
  const mgr = manager(async () => false);
  await (mgr as unknown as { ensureDind(id: string): Promise<void> }).ensureDind("dev-x");
  const log = docker.log();
  expect(log.some((l) => l.startsWith("run -d"))).toBe(true);
  expect(log).toContain("start dind-dev-x");
  expect(log).not.toContain("stop dind-dev-x");
});
